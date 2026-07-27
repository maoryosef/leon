import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatMessage } from '@leon/shared';
import type { LeonConfig } from '../config.js';
import type { EventBus } from '../events.js';
import type { ApprovalService } from '../services/approval-service.js';
import type { ChatService } from '../services/chat-service.js';
import { composeSystemPrompt } from './prompt.js';
import {
  ATLASSIAN_READONLY_TOOLS,
  createLeonToolServer,
  describeMutation,
  type ToolDeps,
} from './tools.js';
import { loadUserMcpServer } from './user-mcp.js';

const KV_AGENT_SESSION = 'agent_session_id';

/**
 * Leon's brain: one long-lived Agent SDK conversation fed by a streaming
 * input queue. Assistant text and tool calls are persisted + broadcast as
 * chat messages; the conversation resumes across daemon restarts.
 */
export class LeonAgent {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private running = false;
  private agentSessionId: string;
  private restartDelayMs = 1000;

  constructor(
    private config: LeonConfig,
    private bus: EventBus,
    private chat: ChatService,
    private approvals: ApprovalService,
    private toolDeps: ToolDeps,
  ) {
    this.agentSessionId = this.chat.getKv(KV_AGENT_SESSION) ?? '';
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runLoop();
    // keep the board's Jira rail fresh: sync shortly after boot, then hourly
    if (loadUserMcpServer('atlassian')) {
      const boot = setTimeout(() => this.requestJiraSync(), 20_000);
      boot.unref?.();
      this.jiraTimer = setInterval(() => this.requestJiraSync(), 60 * 60_000);
      this.jiraTimer.unref?.();
    }
  }

  stop(): void {
    this.running = false;
    if (this.jiraTimer) clearInterval(this.jiraTimer);
    this.wake?.();
  }

  private jiraTimer: NodeJS.Timeout | null = null;

  /** Entry point for POST /api/chat. Persists + broadcasts the user message
   * and feeds it to the model. */
  send(text: string): ChatMessage {
    const message = this.chat.append('user', { kind: 'text', text }, this.agentSessionId);
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.bus.emit({ type: 'chat.status', state: 'thinking', detail: null });
    this.wake?.();
    return message;
  }

  /** Ask the agent to refresh the Jira cache (board rail). Silent turn. */
  requestJiraSync(): void {
    this.queue.push({
      type: 'user',
      message: {
        role: 'user',
        content:
          `[automated jira sync — the user did NOT send this] Refresh the Jira board cache: ` +
          `fetch the user's assigned issues with searchJiraIssuesUsingJql ` +
          `(jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC", ` +
          `maxResults 50, fields: summary, status, priority), then call store_jira_issues with ` +
          `the compact list (key, summary, status, statusCategory name, priority name, and the ` +
          `browse url). Then reply with exactly: SKIP`,
      },
      parent_tool_use_id: null,
    });
    this.wake?.();
  }

  /**
   * Feed a status digest to the model WITHOUT it appearing as a user chat
   * message. Leon decides whether it deserves a proactive comment; replying
   * exactly `SKIP` keeps him quiet (the reply is swallowed).
   */
  injectStatusDigest(digest: string): void {
    const text =
      `[automated session-status update — the user did NOT send this and cannot see it]\n${digest}\n\n` +
      `Report this to the user in ONE short message — they explicitly want to know when a session ` +
      `finishes its work, waits on them, or dies. Include what to do next if obvious (answer the ` +
      `prompt, review the output, restart). Reply with exactly SKIP only if this adds nothing new — ` +
      `you already told them about this exact state, or it's a transient flap that reversed itself.`;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.wake?.();
  }

  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    while (this.running) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.runConversation();
        this.restartDelayMs = 1000;
      } catch (err) {
        // A dead resume target is the common failure — drop it and start fresh.
        if (this.agentSessionId) {
          this.agentSessionId = '';
          this.chat.setKv(KV_AGENT_SESSION, '');
        }
        this.bus.emit({
          type: 'chat.status',
          state: 'error',
          detail: err instanceof Error ? err.message.slice(0, 200) : 'agent crashed',
        });
        await new Promise((r) => setTimeout(r, this.restartDelayMs));
        this.restartDelayMs = Math.min(this.restartDelayMs * 2, 30_000);
      }
    }
  }

  private async runConversation(): Promise<void> {
    const { server, readOnlyToolNames } = createLeonToolServer(this.toolDeps);
    // Mount the user's Atlassian MCP (if configured in Claude Code) so Leon
    // can pull Jira issues — same OAuth store as the CLI, no extra setup.
    const atlassian = loadUserMcpServer('atlassian');
    const stream = query({
      prompt: this.inputStream(),
      options: {
        systemPrompt: composeSystemPrompt(this.config, { jira: atlassian !== null }),
        model: this.config.agent.model,
        cwd: this.config.dataDir, // keep the agent out of any repo
        mcpServers: { leon: server, ...(atlassian ? { atlassian } : {}) },
        // mutating tools are deliberately NOT allowlisted — they must hit
        // canUseTool below, where the human approval gate lives
        allowedTools: [
          ...readOnlyToolNames,
          ...(atlassian ? [...ATLASSIAN_READONLY_TOOLS] : []),
        ],
        settingSources: [], // never load user/project settings (hooks!) into Leon
        maxTurns: 30,
        ...(this.agentSessionId ? { resume: this.agentSessionId } : {}),
        canUseTool: async (toolName, input) => {
          if (!toolName.startsWith('mcp__leon__') && !toolName.startsWith('mcp__atlassian__')) {
            return { behavior: 'deny', message: 'Only Leon and Jira tools are permitted.' };
          }
          const mutation = describeMutation(toolName, input);
          if (!mutation) {
            // read-only tools are auto-allowed
            return { behavior: 'allow', updatedInput: input };
          }
          // Mutating: suspend here until the human decides.
          const { approval, decision } = this.approvals.request({
            toolName: toolName.replace(/^mcp__leon__/, ''),
            toolInput: input,
            summary: mutation.summary,
            risk: mutation.risk,
            ttlMs: mutation.ttlMs,
          });
          const result = await decision;
          if (result.approved) {
            this.toolDeps.tracker.record(toolName, approval.id);
            return { behavior: 'allow', updatedInput: input };
          }
          return {
            behavior: 'deny',
            message: `The user did not approve this action: ${result.reason}`,
          };
        },
      },
    });

    for await (const msg of stream) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        if (msg.session_id && msg.session_id !== this.agentSessionId) {
          this.agentSessionId = msg.session_id;
          this.chat.setKv(KV_AGENT_SESSION, msg.session_id);
        }
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            if (block.text.trim() === 'SKIP') continue; // silent digest ack
            this.chat.append('assistant', { kind: 'text', text: block.text }, this.agentSessionId);
          } else if (block.type === 'tool_use' && block.name.startsWith('mcp__leon__')) {
            // harness-internal tool attempts (ToolSearch etc.) are noise here
            this.chat.append(
              'tool',
              { kind: 'tool', tool: block.name.replace(/^mcp__leon__/, ''), input: block.input },
              this.agentSessionId,
            );
          }
        }
      } else if (msg.type === 'result') {
        this.bus.emit({ type: 'chat.status', state: 'idle', detail: null });
      }
    }
  }
}

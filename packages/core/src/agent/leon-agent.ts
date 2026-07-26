import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatMessage } from '@leon/shared';
import type { LeonConfig } from '../config.js';
import type { EventBus } from '../events.js';
import type { ChatService } from '../services/chat-service.js';
import { composeSystemPrompt } from './prompt.js';
import { createLeonToolServer, type ToolDeps } from './tools.js';

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
    private toolDeps: ToolDeps,
  ) {
    this.agentSessionId = this.chat.getKv(KV_AGENT_SESSION) ?? '';
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runLoop();
  }

  stop(): void {
    this.running = false;
    this.wake?.();
  }

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
    const { server, allowedToolNames } = createLeonToolServer(this.toolDeps);
    const stream = query({
      prompt: this.inputStream(),
      options: {
        systemPrompt: composeSystemPrompt(this.config),
        model: this.config.agent.model,
        cwd: this.config.dataDir, // keep the agent out of any repo
        mcpServers: { leon: server },
        allowedTools: allowedToolNames,
        settingSources: [], // never load user/project settings (hooks!) into Leon
        maxTurns: 30,
        ...(this.agentSessionId ? { resume: this.agentSessionId } : {}),
        canUseTool: async (toolName, input) => {
          // Phase 2a: only Leon's own read-only tools exist; everything else
          // is denied outright. The approval flow lands here later.
          if (toolName.startsWith('mcp__leon__')) {
            return { behavior: 'allow', updatedInput: input };
          }
          return { behavior: 'deny', message: 'Leon has read-only tools for now.' };
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

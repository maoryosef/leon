import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readTranscriptTail } from '../monitor/transcripts.js';
import type { JiraService } from '../services/jira-service.js';
import type { PrPoller } from '../services/pr-service.js';
import type { SessionService } from '../services/session-service.js';
import type { TaskService } from '../services/task-service.js';
import type { Tmux } from '../tmux/tmux.js';

export interface ToolDeps {
  sessions: SessionService;
  tasks: TaskService;
  prs: PrPoller;
  jira: JiraService;
  tmux: Tmux;
  /** Set by canUseTool after an approval; consumed by the mutating tool
   * handler to report executed/failed back onto that approval. */
  tracker: ApprovalTracker;
  approvals: ApprovalReporter;
}

export interface ApprovalReporter {
  markExecuted(id: string, resultSummary: string): void;
  markFailed(id: string, resultSummary: string): void;
}

/** Correlates an approved canUseTool call with its tool execution. */
export class ApprovalTracker {
  private byTool = new Map<string, string[]>();

  record(toolName: string, approvalId: string): void {
    const list = this.byTool.get(toolName) ?? [];
    list.push(approvalId);
    this.byTool.set(toolName, list);
  }

  consume(toolName: string): string | null {
    return this.byTool.get(toolName)?.shift() ?? null;
  }
}

export interface MutationMeta {
  summary: string;
  risk: 'low' | 'medium' | 'high';
  ttlMs?: number;
}

/** Atlassian MCP tools Leon may call without approval (read-only). */
export const ATLASSIAN_READONLY_TOOLS = new Set([
  'mcp__atlassian__atlassianUserInfo',
  'mcp__atlassian__getAccessibleAtlassianResources',
  'mcp__atlassian__getVisibleJiraProjects',
  'mcp__atlassian__searchJiraIssuesUsingJql',
  'mcp__atlassian__getJiraIssue',
  'mcp__atlassian__getTransitionsForJiraIssue',
  'mcp__atlassian__getJiraIssueRemoteIssueLinks',
  'mcp__atlassian__lookupJiraAccountId',
  'mcp__atlassian__search',
]);

/** Which tools mutate, how risky they are, and how to describe them to the
 * user on the ApprovalCard. Returns null for read-only tools. */
export function describeMutation(toolName: string, input: Record<string, unknown>): MutationMeta | null {
  // Atlassian tools: reads are free, every write is approval-gated with a
  // generic-but-honest summary (the input JSON is on the card anyway).
  if (toolName.startsWith('mcp__atlassian__')) {
    if (ATLASSIAN_READONLY_TOOLS.has(toolName)) return null;
    const bare = toolName.replace(/^mcp__atlassian__/, '');
    const hint = String(
      input.issueIdOrKey ?? input.issueKey ?? input.projectKey ?? input.pageId ?? '',
    );
    return { summary: `Jira/Confluence: ${bare}${hint ? ` on ${hint}` : ''}`, risk: 'medium' };
  }
  const name = toolName.replace(/^mcp__leon__/, '');
  const s = (k: string) => String(input[k] ?? '');
  switch (name) {
    case 'create_task':
      return { summary: `Create task “${s('title')}”`, risk: 'low' };
    case 'link_session_to_task':
      return {
        summary: input.taskId
          ? `Link session ${s('session')} to task ${s('taskId')}`
          : `Move session ${s('session')} back to the Inbox`,
        risk: 'low',
      };
    case 'nudge_session':
      return { summary: `Nudge session ${s('session')} for a status update`, risk: 'medium' };
    case 'send_to_session':
      return {
        summary: `Type into session ${s('session')}: “${s('text').slice(0, 120)}”${input.pressEnter === false ? ' (no Enter)' : ''}`,
        risk: 'high',
      };
    case 'answer_permission_prompt':
      return {
        summary: `Answer the permission prompt in session ${s('session')} with “${s('option')}”`,
        risk: 'high',
        ttlMs: 60_000, // prompts move; a stale yes is worse than no yes
      };
    case 'kill_session':
      return { summary: `Kill session ${s('session')} (tmux pane closes)`, risk: 'high' };
    default:
      return null;
  }
}

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] };
}

/**
 * Leon's capability surface. Phase 2a: read-only tools, auto-allowed.
 * Mutating tools (send_to_session, spawn_session, …) arrive with the
 * approval flow and are gated through canUseTool.
 */
export function createLeonToolServer(deps: ToolDeps) {
  const list_sessions = tool(
    'list_sessions',
    'All live Claude Code sessions with status, directory, tmux coordinates and current activity.',
    {},
    async () =>
      json(
        deps.sessions.listActive().map((s) => ({
          id: s.id,
          shortId: s.id.slice(-8).toLowerCase(),
          dir: s.cwd,
          tmux: `${s.tmuxSessionName}:${s.tmuxWindowIndex}`,
          status: s.status,
          statusSource: s.statusSource,
          statusSince: s.statusSince,
          activity: s.currentActivity,
          taskId: s.taskId,
          title: s.title,
        })),
      ),
  );

  const list_tasks = tool(
    'list_tasks',
    'All tasks (units of work spanning repos/sessions/PRs) with their status.',
    {},
    async () => json(deps.tasks.list()),
  );

  const get_pr_status = tool(
    'get_pr_status',
    "Pull requests Leon monitors (the user's open PRs + live session branches): state, checks, review decision.",
    {},
    async () => json(deps.prs.list()),
  );

  const peek_session = tool(
    'peek_session',
    'Read the visible terminal contents of a session (like glancing at its pane).',
    {
      session: z
        .string()
        .describe('Session short id, directory basename, tmux session name, or title'),
      lines: z.number().int().min(5).max(300).default(60).describe('How many trailing lines'),
    },
    async (args) => {
      const session = deps.sessions.findByQuery(args.session);
      if (!session) return json({ error: `no live session matches "${args.session}"` });
      try {
        const text = await deps.tmux.capturePane(session.tmuxPaneId);
        const tail = text.split('\n').slice(-args.lines).join('\n');
        return json({ session: session.id.slice(-8), dir: session.cwd, screen: tail });
      } catch {
        return json({ error: 'pane is gone' });
      }
    },
  );

  const get_session_transcript_tail = tool(
    'get_session_transcript_tail',
    "The last N entries of a session's Claude Code transcript — richer than the screen: shows what the agent actually did (messages + tool calls).",
    {
      session: z
        .string()
        .describe('Session short id, directory basename, tmux session name, or title'),
      entries: z.number().int().min(3).max(60).default(15),
    },
    async (args) => {
      const session = deps.sessions.findByQuery(args.session);
      if (!session) return json({ error: `no live session matches "${args.session}"` });
      if (!session.transcriptPath) {
        return json({ error: 'no transcript correlated for this session yet' });
      }
      return json({
        session: session.id.slice(-8),
        dir: session.cwd,
        entries: readTranscriptTail(session.transcriptPath, args.entries),
      });
    },
  );

  /* ---------------- mutating tools (approval-gated via canUseTool) -------- */

  // Runs the action, reports the outcome onto the approval that let it through.
  const reporting = (
    toolName: string,
    fn: () => Promise<{ ok: string } | { error: string }>,
  ): Promise<{ content: { type: 'text'; text: string }[] }> => {
    const approvalId = deps.tracker.consume(`mcp__leon__${toolName}`);
    return fn()
      .then((res) => {
        if (approvalId) {
          if ('ok' in res) deps.approvals.markExecuted(approvalId, res.ok);
          else deps.approvals.markFailed(approvalId, res.error);
        }
        return json(res);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'action failed';
        if (approvalId) deps.approvals.markFailed(approvalId, msg);
        return json({ error: msg });
      });
  };

  const resolveSession = (query: string) => deps.sessions.findByQuery(query);

  const send_to_session = tool(
    'send_to_session',
    'Type text into a session’s terminal (optionally pressing Enter). Requires user approval.',
    {
      session: z.string().describe('Session short id, directory basename, tmux name, or title'),
      text: z.string().min(1).max(2000),
      pressEnter: z.boolean().default(true),
    },
    async (args) =>
      reporting('send_to_session', async () => {
        const session = resolveSession(args.session);
        if (!session) return { error: `no live session matches "${args.session}"` };
        await deps.tmux.sendKeys(session.tmuxPaneId, args.text, args.pressEnter);
        return { ok: `sent to ${session.cwd.split('/').pop()} (${session.tmuxPaneId})` };
      }),
  );

  const answer_permission_prompt = tool(
    'answer_permission_prompt',
    'Answer a Claude Code permission prompt in a session (pick a numbered option, or esc). Re-checks that the prompt is still on screen before sending. Requires user approval.',
    {
      session: z.string(),
      option: z.string().regex(/^([1-9]|esc)$/, 'a digit 1-9 or "esc"'),
    },
    async (args) =>
      reporting('answer_permission_prompt', async () => {
        const session = resolveSession(args.session);
        if (!session) return { error: `no live session matches "${args.session}"` };
        // the prompt may have been answered/dismissed while approval was pending
        const screen = await deps.tmux.capturePane(session.tmuxPaneId);
        const tail = screen.split('\n').slice(-25).join('\n');
        if (!/❯?\s*1\.\s/.test(tail)) {
          return { error: `no selector prompt on screen anymore — current tail:\n${tail.slice(-600)}` };
        }
        if (args.option === 'esc') {
          await deps.tmux.sendKey(session.tmuxPaneId, 'Escape');
          return { ok: 'sent Escape (cancelled the prompt)' };
        }
        await deps.tmux.sendKeys(session.tmuxPaneId, args.option, false);
        return { ok: `selected option ${args.option}` };
      }),
  );

  const nudge_session = tool(
    'nudge_session',
    'Send a short status-check message to a session’s agent. Requires user approval.',
    {
      session: z.string(),
      message: z
        .string()
        .max(300)
        .default('Quick status check: what are you working on right now, and are you blocked on anything?'),
    },
    async (args) =>
      reporting('nudge_session', async () => {
        const session = resolveSession(args.session);
        if (!session) return { error: `no live session matches "${args.session}"` };
        await deps.tmux.sendKeys(session.tmuxPaneId, args.message, true);
        return { ok: `nudged ${session.cwd.split('/').pop()}` };
      }),
  );

  const kill_session = tool(
    'kill_session',
    'Kill a session’s tmux pane (the claude process dies with it). Requires user approval.',
    { session: z.string() },
    async (args) =>
      reporting('kill_session', async () => {
        const session = resolveSession(args.session);
        if (!session) return { error: `no live session matches "${args.session}"` };
        await deps.tmux.killPane(session.tmuxPaneId);
        return { ok: `killed pane ${session.tmuxPaneId} (${session.cwd.split('/').pop()})` };
      }),
  );

  const create_task = tool(
    'create_task',
    'Create a new task on the board (optionally linked to a Jira issue via jiraKey). Requires user approval.',
    {
      title: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      jiraKey: z.string().max(30).optional().describe('e.g. ENG-3272'),
    },
    async (args) =>
      reporting('create_task', async () => {
        const task = deps.tasks.create(
          { title: args.title, description: args.description, jiraKey: args.jiraKey },
          'leon',
        );
        return { ok: `created task "${task.title}" (${task.id.slice(-8)})${args.jiraKey ? ` ← ${args.jiraKey}` : ''}` };
      }),
  );

  const link_session_to_task = tool(
    'link_session_to_task',
    'Assign a session to a task (or back to the Inbox with taskId null). Requires user approval.',
    { session: z.string(), taskId: z.string().nullable() },
    async (args) =>
      reporting('link_session_to_task', async () => {
        const session = resolveSession(args.session);
        if (!session) return { error: `no live session matches "${args.session}"` };
        if (args.taskId) {
          const task = deps.tasks.get(args.taskId) ?? deps.tasks.list().find((t) => t.id.endsWith(args.taskId!));
          if (!task) return { error: `no task ${args.taskId}` };
          deps.sessions.link(session.id, task.id);
          return { ok: `linked ${session.cwd.split('/').pop()} → "${task.title}"` };
        }
        deps.sessions.link(session.id, null);
        return { ok: `moved ${session.cwd.split('/').pop()} to Inbox` };
      }),
  );

  const store_jira_issues = tool(
    'store_jira_issues',
    "Replace Leon's local cache of the user's assigned Jira issues (shown in the board's JIRA rail). Call after fetching fresh data from the Atlassian tools.",
    {
      issues: z
        .array(
          z.object({
            key: z.string().max(30),
            summary: z.string().max(300),
            status: z.string().max(60),
            statusCategory: z.string().max(30).optional(),
            priority: z.string().max(30).optional(),
            url: z.string().max(300),
          }),
        )
        .max(100),
    },
    async (args) => {
      const stored = deps.jira.replaceAll(args.issues);
      return json({ ok: `cached ${stored.length} jira issues` });
    },
  );

  // store_jira_issues counts as read-only: it only refreshes Leon's own
  // local cache from data the read-only Atlassian tools returned.
  const readOnly = [
    list_sessions,
    list_tasks,
    get_pr_status,
    peek_session,
    get_session_transcript_tail,
    store_jira_issues,
  ];
  const mutating = [
    send_to_session,
    answer_permission_prompt,
    nudge_session,
    kill_session,
    create_task,
    link_session_to_task,
  ];
  return {
    server: createSdkMcpServer({ name: 'leon', version: '0.1.0', tools: [...readOnly, ...mutating] }),
    // ⚠ SECURITY: allowedTools entries are PRE-APPROVED by the SDK and skip
    // canUseTool entirely. Only read-only tools may appear here; mutating
    // tools must fall through to canUseTool, where the approval gate lives.
    readOnlyToolNames: readOnly.map((t) => `mcp__leon__${t.name}`),
  };
}

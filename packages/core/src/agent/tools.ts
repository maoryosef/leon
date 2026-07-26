import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readTranscriptTail } from '../monitor/transcripts.js';
import type { PrPoller } from '../services/pr-service.js';
import type { SessionService } from '../services/session-service.js';
import type { TaskService } from '../services/task-service.js';
import type { Tmux } from '../tmux/tmux.js';

export interface ToolDeps {
  sessions: SessionService;
  tasks: TaskService;
  prs: PrPoller;
  tmux: Tmux;
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

  const tools = [list_sessions, list_tasks, get_pr_status, peek_session, get_session_transcript_tail];
  return {
    server: createSdkMcpServer({ name: 'leon', version: '0.1.0', tools }),
    allowedToolNames: tools.map((t) => `mcp__leon__${t.name}`),
  };
}

import { z } from 'zod';
import { SessionStatus, StatusSource } from './status.js';

export const TaskStatus = z.enum(['active', 'paused', 'done', 'archived']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskSource = z.enum(['manual', 'leon', 'discovered', 'jira']);
export type TaskSource = z.infer<typeof TaskSource>;

/** The primary unit of work: spans repos, sessions and PRs. */
export const Task = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  status: TaskStatus,
  source: TaskSource,
  jiraKey: z.string().nullish(),
  /** rail position, ascending; ties break on createdAt */
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const SessionOrigin = z.enum(['spawned', 'discovered']);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

/** One Claude Code instance in one tmux pane. */
export const Session = z.object({
  id: z.string(),
  taskId: z.string().nullish(), // null => Inbox (unassigned)
  // tmux coordinates — the pane is the real unit
  tmuxSessionName: z.string(),
  tmuxWindowIndex: z.number().int(),
  tmuxPaneId: z.string(), // "%42" — unique per tmux server lifetime
  panePid: z.number().int(), // pane's shell pid; claude is a child
  cwd: z.string(),
  // Claude Code identity (filled in when known)
  claudeSessionId: z.string().nullish(),
  transcriptPath: z.string().nullish(),
  instrumented: z.boolean(),
  // lifecycle
  origin: SessionOrigin,
  status: SessionStatus,
  statusSince: z.string(),
  statusSource: StatusSource,
  /** Last tool the agent used (from PreToolUse hook / transcript), for the board. */
  currentActivity: z.string().nullish(),
  lastActivityAt: z.string(),
  title: z.string().nullish(),
  archivedAt: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof Session>;

export const Repo = z.object({
  id: z.string(),
  path: z.string(), // absolute local path, unique
  name: z.string(),
  defaultBranch: z.string(),
  remoteUrl: z.string().nullish(),
});
export type Repo = z.infer<typeof Repo>;

export const PrState = z.enum(['open', 'merged', 'closed', 'draft']);
export type PrState = z.infer<typeof PrState>;

export const PrChecks = z.enum(['pending', 'passing', 'failing', 'none']);
export type PrChecks = z.infer<typeof PrChecks>;

export const PullRequest = z.object({
  id: z.string(),
  repoId: z.string(),
  taskId: z.string().nullish(),
  sessionId: z.string().nullish(),
  number: z.number().int(),
  branch: z.string(),
  title: z.string(),
  url: z.string(),
  state: PrState,
  checks: PrChecks,
  reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullish(),
  /** comments + reviews on the PR (all authors) */
  commentCount: z.number().int().default(0),
  /** newest comment/review by someone OTHER than the user */
  lastCommentAuthor: z.string().nullish(),
  lastCommentAt: z.string().nullish(),
  lastSyncedAt: z.string(),
});
export type PullRequest = z.infer<typeof PullRequest>;

export const ApprovalStatus = z.enum([
  'pending',
  'approved',
  'denied',
  'expired',
  'executed',
  'failed',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** Human-in-the-loop gate for every mutating action Leon proposes. */
export const Approval = z.object({
  id: z.string(),
  chatMessageId: z.string().nullish(),
  toolName: z.string(),
  toolInput: z.unknown(),
  summary: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  status: ApprovalStatus,
  decidedAt: z.string().nullish(),
  decidedVia: z.enum(['web', 'tui', 'auto_allow']).nullish(),
  resultSummary: z.string().nullish(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type Approval = z.infer<typeof Approval>;

/** What a chat message holds: plain text, or a tool call Leon made. */
export const ChatContent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('tool'), tool: z.string(), input: z.unknown() }),
]);
export type ChatContent = z.infer<typeof ChatContent>;

/** A Jira issue assigned to the user (cached locally; Leon syncs it). */
export const JiraIssue = z.object({
  key: z.string(), // "ENG-3272"
  summary: z.string(),
  status: z.string(),
  statusCategory: z.string().nullish(), // "To Do" | "In Progress" | "Done"
  priority: z.string().nullish(),
  url: z.string(),
  syncedAt: z.string(),
});
export type JiraIssue = z.infer<typeof JiraIssue>;

/**
 * One of the plan's rate limits, as reported by Claude's OAuth usage endpoint:
 * the rolling 5-hour session pool, the all-models weekly pool, and (on plans
 * that have one) a weekly pool scoped to a single model.
 */
export const UsageLimit = z.object({
  /** 'session' | 'weekly_all' | 'weekly_scoped' — passthrough, new kinds appear */
  kind: z.string(),
  /** 'session' | 'weekly' */
  group: z.string().nullish(),
  /** what to call it in the UI, e.g. "weekly" or "Fable weekly" */
  label: z.string(),
  /** percent of the pool consumed, 0-100 */
  percent: z.number(),
  severity: z.enum(['normal', 'warning', 'critical']).catch('normal'),
  /** ISO 8601; null when the pool has never been touched */
  resetsAt: z.string().nullish(),
});
export type UsageLimit = z.infer<typeof UsageLimit>;

export const Usage = z.object({
  limits: z.array(UsageLimit),
  fetchedAt: z.string(),
  /** set when the last poll failed; the limits are then the last good ones */
  error: z.string().nullish(),
});
export type Usage = z.infer<typeof Usage>;

/** Leon's own conversation: how full its context is and what it has cost. */
export const AgentStats = z.object({
  /** tokens the model carried into its most recent request (input + cache) */
  contextTokens: z.number().nullish(),
  /** the model's context window, as the SDK reported it */
  contextWindow: z.number().nullish(),
  /** cumulative USD for this Leon session, surviving daemon restarts */
  costUsd: z.number(),
  model: z.string().nullish(),
  updatedAt: z.string(),
});
export type AgentStats = z.infer<typeof AgentStats>;

export const ChatMessage = z.object({
  id: z.string(),
  agentSessionId: z.string(), // '' until the agent session is established
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: ChatContent,
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

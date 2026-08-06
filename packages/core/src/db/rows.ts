import type { Approval, PullRequest, Session, Task } from '@leon/shared';

/** snake_case DB row ↔ camelCase domain mapping, kept in one place. */

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  source: string;
  jira_key: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export function taskFromRow(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status as Task['status'],
    source: r.source as Task['source'],
    jiraKey: r.jira_key,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface SessionRow {
  id: string;
  task_id: string | null;
  tmux_session_name: string;
  tmux_window_index: number;
  tmux_pane_id: string;
  pane_pid: number;
  cwd: string;
  claude_session_id: string | null;
  transcript_path: string | null;
  instrumented: number;
  origin: string;
  status: string;
  status_since: string;
  status_source: string;
  current_activity: string | null;
  last_activity_at: string;
  title: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function sessionFromRow(r: SessionRow): Session {
  return {
    id: r.id,
    taskId: r.task_id,
    tmuxSessionName: r.tmux_session_name,
    tmuxWindowIndex: r.tmux_window_index,
    tmuxPaneId: r.tmux_pane_id,
    panePid: r.pane_pid,
    cwd: r.cwd,
    claudeSessionId: r.claude_session_id,
    transcriptPath: r.transcript_path,
    instrumented: r.instrumented === 1,
    origin: r.origin as Session['origin'],
    status: r.status as Session['status'],
    statusSince: r.status_since,
    statusSource: r.status_source as Session['statusSource'],
    currentActivity: r.current_activity,
    lastActivityAt: r.last_activity_at,
    title: r.title,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface PullRequestRow {
  id: string;
  repo_id: string;
  task_id: string | null;
  session_id: string | null;
  number: number;
  branch: string;
  title: string;
  url: string;
  state: string;
  checks: string;
  review_decision: string | null;
  comment_count: number;
  last_comment_author: string | null;
  last_comment_at: string | null;
  last_synced_at: string;
}

export function prFromRow(r: PullRequestRow): PullRequest {
  return {
    id: r.id,
    repoId: r.repo_id,
    taskId: r.task_id,
    sessionId: r.session_id,
    number: r.number,
    branch: r.branch,
    title: r.title,
    url: r.url,
    state: r.state as PullRequest['state'],
    checks: r.checks as PullRequest['checks'],
    reviewDecision: r.review_decision as PullRequest['reviewDecision'],
    commentCount: r.comment_count,
    lastCommentAuthor: r.last_comment_author,
    lastCommentAt: r.last_comment_at,
    lastSyncedAt: r.last_synced_at,
  };
}

export interface ApprovalRow {
  id: string;
  chat_message_id: string | null;
  tool_name: string;
  tool_input: string;
  summary: string;
  risk: string;
  status: string;
  decided_at: string | null;
  decided_via: string | null;
  result_summary: string | null;
  created_at: string;
  expires_at: string;
}

export function approvalFromRow(r: ApprovalRow): Approval {
  return {
    id: r.id,
    chatMessageId: r.chat_message_id,
    toolName: r.tool_name,
    toolInput: JSON.parse(r.tool_input) as unknown,
    summary: r.summary,
    risk: r.risk as Approval['risk'],
    status: r.status as Approval['status'],
    decidedAt: r.decided_at,
    decidedVia: r.decided_via as Approval['decidedVia'],
    resultSummary: r.result_summary,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

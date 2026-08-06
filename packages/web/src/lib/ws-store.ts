import { WsEvent } from '@leon/shared';
import type { Approval, ChatMessage, JiraIssue, PullRequest, Session, Task } from '@leon/shared';
import { useSyncExternalStore } from 'react';
import type { StateResponse } from './api';
import { wsUrl } from './token';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export type View = 'board' | 'sessions' | 'archive';

/** URL hash ↔ view: '#sessions' / '#archive'; anything else is the board. */
function readViewFromHash(): View {
  if (window.location.hash === '#sessions') return 'sessions';
  if (window.location.hash === '#archive') return 'archive';
  return 'board';
}

export interface ChatStatus {
  state: 'thinking' | 'idle' | 'error';
  detail: string | null;
}

export interface BoardState {
  tasks: Task[];
  sessions: Session[];
  pullRequests: PullRequest[];
  jiraIssues: JiraIssue[];
  /** last scratchpad state pushed over WS (null until first update) */
  scratchpad: { content: string; updatedAt: string; origin: 'user' | 'leon' } | null;
  /** Pending approvals only — resolved ones are removed as they resolve. */
  approvals: Approval[];
  /** Most recent approval that resolved with status 'failed' (for the chat feedback line). */
  lastApprovalFailure: Approval | null;
  chatMessages: ChatMessage[];
  /** true once GET /api/chat history has been applied */
  chatLoaded: boolean;
  chatStatus: ChatStatus;
  /** assistant text messages newer than the persisted lastSeen marker */
  unreadCount: number;
  /** true once a snapshot (WS or REST seed) has been applied */
  loaded: boolean;
  connection: ConnectionStatus;
  /** which top-level screen is showing — synced to the URL hash (#sessions) */
  view: View;
  /** session whose TerminalModal is open — shared so chips/dock/rail can all open it */
  openSessionId: string | null;
  /** pre-filled chat input requested by other panels; ChatPanel consumes + clears */
  chatDraft: string | null;
}

let state: BoardState = {
  tasks: [],
  sessions: [],
  pullRequests: [],
  jiraIssues: [],
  scratchpad: null,
  approvals: [],
  lastApprovalFailure: null,
  chatMessages: [],
  chatLoaded: false,
  chatStatus: { state: 'idle', detail: null },
  unreadCount: 0,
  loaded: false,
  connection: 'connecting',
  view: readViewFromHash(),
  openSessionId: null,
  chatDraft: null,
};

const listeners = new Set<() => void>();

function setState(next: BoardState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBoardState(): BoardState {
  return useSyncExternalStore(subscribe, () => state);
}

/* ------------------------------------------------------------------ */
/* UI slice                                                            */
/* ------------------------------------------------------------------ */

/** Switch the top-level view and keep the URL hash in sync (so reload/back work). */
export function setView(view: View): void {
  if (state.view !== view) setState({ ...state, view });
  const targetHash = view === 'board' ? '' : `#${view}`;
  if (window.location.hash !== targetHash) {
    if (view !== 'board') {
      window.location.hash = view;
    } else {
      // pushState instead of `location.hash = ''` so we don't leave a dangling '#'
      window.history.pushState(null, '', window.location.pathname + window.location.search);
    }
  }
}
export function setOpenSession(sessionId: string | null): void {
  if (state.openSessionId === sessionId) return;
  setState({ ...state, openSessionId: sessionId });
}

/** Ask ChatPanel to pre-fill its input ("ask Leon" from the dock). */
export function setChatDraft(draft: string | null): void {
  if (state.chatDraft === draft) return;
  setState({ ...state, chatDraft: draft });
}

/* ------------------------------------------------------------------ */
/* Unread tracking                                                     */
/*                                                                     */
/* A persisted lastSeen marker (createdAt of the newest message the    */
/* user has actually looked at) splits assistant text messages into    */
/* seen/unread. Tool chips and the user's own messages never count.    */
/* ------------------------------------------------------------------ */

const LAST_SEEN_KEY = 'leon.chat.lastSeen';

function loadLastSeen(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_SEEN_KEY);
    if (!raw) return null;
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

function persistLastSeen(at: number): void {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, new Date(at).toISOString());
  } catch {
    // localStorage unavailable — unread just won't survive a reload.
  }
}

/** null until the first history seed of a fresh browser establishes a baseline. */
let lastSeenAt: number | null = loadLastSeen();

function countUnread(messages: ChatMessage[]): number {
  if (lastSeenAt === null) return 0;
  const marker = lastSeenAt;
  return messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.content.kind === 'text' &&
      Date.parse(message.createdAt) > marker,
  ).length;
}

function newestCreatedAt(messages: ChatMessage[]): number | null {
  let newest: number | null = null;
  for (const message of messages) {
    const at = Date.parse(message.createdAt);
    if (!Number.isNaN(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/** The chat panel calls this once open + visible + scrolled to bottom. */
export function markChatSeen(): void {
  const newest = newestCreatedAt(state.chatMessages);
  if (newest === null) return;
  if (lastSeenAt !== null && newest <= lastSeenAt && state.unreadCount === 0) return;
  lastSeenAt = Math.max(newest, lastSeenAt ?? 0);
  persistLastSeen(lastSeenAt);
  if (state.unreadCount !== 0) setState({ ...state, unreadCount: 0 });
}

/* ------------------------------------------------------------------ */
/* Reducer                                                             */
/* ------------------------------------------------------------------ */

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

export function applyEvent(event: WsEvent): void {
  switch (event.type) {
    case 'snapshot':
      setState({
        ...state,
        tasks: event.tasks,
        sessions: event.sessions,
        pullRequests: event.pullRequests,
        approvals: event.approvals,
        jiraIssues: event.jiraIssues ?? state.jiraIssues,
        loaded: true,
      });
      break;
    case 'task.upserted':
      setState({ ...state, tasks: upsert(state.tasks, event.task) });
      break;
    case 'task.deleted':
      setState({ ...state, tasks: state.tasks.filter((task) => task.id !== event.taskId) });
      break;
    case 'session.upserted':
    case 'session.status':
      setState({ ...state, sessions: upsert(state.sessions, event.session) });
      break;
    case 'pr.upserted':
      setState({ ...state, pullRequests: upsert(state.pullRequests, event.pullRequest) });
      break;
    case 'scratchpad.updated':
      setState({
        ...state,
        scratchpad: { content: event.content, updatedAt: event.updatedAt, origin: event.origin },
      });
      break;
    case 'jira.synced':
      setState({ ...state, jiraIssues: event.issues });
      break;
    case 'pr.deleted':
      setState({
        ...state,
        pullRequests: state.pullRequests.filter((pr) => pr.id !== event.pullRequestId),
      });
      break;
    case 'approval.requested':
      setState({ ...state, approvals: upsert(state.approvals, event.approval) });
      break;
    case 'approval.resolved':
      applyApproval(event.approval);
      break;
    case 'chat.message': {
      const chatMessages = capChat(upsert(state.chatMessages, event.message));
      setState({ ...state, chatMessages, unreadCount: countUnread(chatMessages) });
      break;
    }
    case 'chat.delta':
      // In the schema but not emitted by the daemon yet — ignore gracefully.
      break;
    case 'chat.status':
      setState({ ...state, chatStatus: { state: event.state, detail: event.detail ?? null } });
      break;
  }
}

/** Mirror the daemon's history cap so a long-lived tab doesn't grow unbounded. */
const CHAT_CAP = 200;

function capChat(messages: ChatMessage[]): ChatMessage[] {
  return messages.length > CHAT_CAP ? messages.slice(-CHAT_CAP) : messages;
}

/** Seed chat from GET /api/chat; WS messages that raced ahead are layered on top. */
export function seedChatHistory(history: ChatMessage[]): void {
  if (state.chatLoaded) return;
  let merged = history;
  for (const message of state.chatMessages) merged = upsert(merged, message);
  const capped = capChat(merged);
  if (lastSeenAt === null) {
    // Fresh browser: treat everything already in history as seen so the
    // first visit isn't greeted by a giant stale count.
    lastSeenAt = newestCreatedAt(capped) ?? 0;
    persistLastSeen(lastSeenAt);
  }
  setState({ ...state, chatMessages: capped, chatLoaded: true, unreadCount: countUnread(capped) });
}

/** Seed the store from GET /api/state; a WS snapshot always overwrites it. */
export function seedFromRest(snapshot: StateResponse): void {
  if (state.loaded) return;
  setState({ ...state, ...snapshot, loaded: true });
}

/* Optimistic-ish appliers for REST mutation responses (idempotent with WS). */

export function applyTask(task: Task): void {
  setState({ ...state, tasks: upsert(state.tasks, task) });
}

/** Replace the whole task list (used by the reorder response). */
export function applyTasks(tasks: Task[]): void {
  setState({ ...state, tasks });
}

export function removeTask(taskId: string): void {
  setState({ ...state, tasks: state.tasks.filter((task) => task.id !== taskId) });
}

export function applySession(session: Session): void {
  setState({ ...state, sessions: upsert(state.sessions, session) });
}

/**
 * Apply an approval in whatever state it arrived (WS resolve or REST decide
 * response). Pending → upsert; anything else leaves the pending list. A
 * 'failed' resolution (may fire after 'approved'/'executed') is remembered so
 * the chat panel can surface it. Idempotent — WS and REST may both deliver it.
 */
export function applyApproval(approval: Approval): void {
  const approvals =
    approval.status === 'pending'
      ? upsert(state.approvals, approval)
      : state.approvals.filter((existing) => existing.id !== approval.id);
  setState({
    ...state,
    approvals,
    lastApprovalFailure: approval.status === 'failed' ? approval : state.lastApprovalFailure,
  });
}

/** Drop a card locally (e.g. decide returned 404/409 — WS will reconcile). */
export function removeApproval(approvalId: string): void {
  setState({
    ...state,
    approvals: state.approvals.filter((approval) => approval.id !== approvalId),
  });
}

/* ------------------------------------------------------------------ */
/* /ws/events connection with 1s → 10s backoff                         */
/* ------------------------------------------------------------------ */

let started = false;
let attempt = 0;

export function startEvents(): void {
  if (started) return;
  started = true;
  // back/forward between #sessions and the board re-applies the hash
  window.addEventListener('hashchange', () => {
    const view = readViewFromHash();
    if (state.view !== view) setState({ ...state, view });
  });
  connect();
}

function connect(): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl('/ws/events'));
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    attempt = 0;
    setState({ ...state, connection: 'connected' });
  };

  ws.onmessage = (msg: MessageEvent) => {
    if (typeof msg.data !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(msg.data);
    } catch {
      return;
    }
    const parsed = WsEvent.safeParse(json);
    if (parsed.success) applyEvent(parsed.data);
  };

  ws.onclose = () => {
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  setState({ ...state, connection: 'reconnecting' });
  const delay = Math.min(10_000, 1_000 * 2 ** attempt);
  attempt += 1;
  window.setTimeout(connect, delay);
}

import { WsEvent } from '@leon/shared';
import type { Approval, ChatMessage, PullRequest, Session, Task } from '@leon/shared';
import { useSyncExternalStore } from 'react';
import type { StateResponse } from './api';
import { wsUrl } from './token';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface ChatStatus {
  state: 'thinking' | 'idle' | 'error';
  detail: string | null;
}

export interface BoardState {
  tasks: Task[];
  sessions: Session[];
  pullRequests: PullRequest[];
  /** Pending approvals only — resolved ones are removed as they resolve. */
  approvals: Approval[];
  /** Most recent approval that resolved with status 'failed' (for the chat feedback line). */
  lastApprovalFailure: Approval | null;
  chatMessages: ChatMessage[];
  /** true once GET /api/chat history has been applied */
  chatLoaded: boolean;
  chatStatus: ChatStatus;
  /** true once a snapshot (WS or REST seed) has been applied */
  loaded: boolean;
  connection: ConnectionStatus;
}

let state: BoardState = {
  tasks: [],
  sessions: [],
  pullRequests: [],
  approvals: [],
  lastApprovalFailure: null,
  chatMessages: [],
  chatLoaded: false,
  chatStatus: { state: 'idle', detail: null },
  loaded: false,
  connection: 'connecting',
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
    case 'approval.requested':
      setState({ ...state, approvals: upsert(state.approvals, event.approval) });
      break;
    case 'approval.resolved':
      applyApproval(event.approval);
      break;
    case 'chat.message':
      setState({ ...state, chatMessages: capChat(upsert(state.chatMessages, event.message)) });
      break;
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
  setState({ ...state, chatMessages: capChat(merged), chatLoaded: true });
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

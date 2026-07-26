import { WsEvent } from '@leon/shared';
import type { Approval, PullRequest, Session, Task } from '@leon/shared';
import { useSyncExternalStore } from 'react';
import type { StateResponse } from './api';
import { wsUrl } from './token';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface BoardState {
  tasks: Task[];
  sessions: Session[];
  pullRequests: PullRequest[];
  approvals: Approval[];
  /** true once a snapshot (WS or REST seed) has been applied */
  loaded: boolean;
  connection: ConnectionStatus;
}

let state: BoardState = {
  tasks: [],
  sessions: [],
  pullRequests: [],
  approvals: [],
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
    case 'approval.resolved':
      setState({ ...state, approvals: upsert(state.approvals, event.approval) });
      break;
    case 'chat.message':
    case 'chat.delta':
      // Phase 2 (chat) — intentionally ignored for now.
      break;
  }
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

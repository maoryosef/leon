import type {
  Approval,
  CreateTaskInput,
  PullRequest,
  Session,
  Task,
  UpdateTaskInput,
} from '@leon/shared';
import { useSyncExternalStore } from 'react';
import { getToken } from './token';

export interface StateResponse {
  tasks: Task[];
  sessions: Session[];
  pullRequests: PullRequest[];
  approvals: Approval[];
}

/* ------------------------------------------------------------------ */
/* 401 handling — a tiny global flag any fetch can trip.               */
/* ------------------------------------------------------------------ */

let unauthorized = false;
const authListeners = new Set<() => void>();

function markUnauthorized(): void {
  if (unauthorized) return;
  unauthorized = true;
  for (const listener of authListeners) listener();
}

function subscribeAuth(listener: () => void): () => void {
  authListeners.add(listener);
  return () => {
    authListeners.delete(listener);
  };
}

export function useUnauthorized(): boolean {
  return useSyncExternalStore(subscribeAuth, () => unauthorized);
}

/* ------------------------------------------------------------------ */
/* REST                                                                */
/* ------------------------------------------------------------------ */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (init?.body != null) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    markUnauthorized();
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function fetchState(): Promise<StateResponse> {
  return request<StateResponse>('/api/state');
}

export function createTask(input: CreateTaskInput): Promise<Task> {
  return request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(input) });
}

export function updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
  return request<Task>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function linkSession(id: string, taskId: string | null): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/link`, {
    method: 'POST',
    body: JSON.stringify({ taskId }),
  });
}

export function updateSessionTitle(id: string, title: string | null): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export function fetchCapture(id: string): Promise<{ text: string }> {
  return request<{ text: string }>(`/api/sessions/${encodeURIComponent(id)}/capture`);
}

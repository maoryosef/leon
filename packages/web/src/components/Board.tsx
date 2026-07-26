import type { PullRequest, Session, SessionStatus, Task, TaskStatus } from '@leon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { deleteTask, linkSession, updateTask } from '../lib/api';
import { applySession, applyTask, removeTask } from '../lib/ws-store';
import { useNow } from '../lib/time';
import { TaskColumn } from './TaskColumn';

const STATUS_ORDER: Record<SessionStatus, number> = {
  waiting_permission: 0,
  waiting_input: 1,
  working: 2,
  idle_done: 3,
  unknown: 4,
  dead: 5,
};

function sortSessions(sessions: Session[]): Session[] {
  return sessions.slice().sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  });
}

export function Board({
  tasks,
  sessions,
  pullRequests,
  onOpenSession,
}: {
  tasks: Task[];
  sessions: Session[];
  pullRequests: PullRequest[];
  onOpenSession: (session: Session) => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const now = useNow();
  const queryClient = useQueryClient();

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['state'] });

  const linkMutation = useMutation({
    mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string | null }) =>
      linkSession(sessionId, taskId),
    onSuccess: (session) => {
      applySession(session);
      invalidate();
    },
  });

  const updateTaskMutation = useMutation({
    mutationFn: ({ taskId, title, status }: { taskId: string; title?: string; status?: TaskStatus }) =>
      updateTask(taskId, { ...(title ? { title } : {}), ...(status ? { status } : {}) }),
    onSuccess: (task) => {
      applyTask(task);
      invalidate();
    },
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => deleteTask(taskId),
    onSuccess: (_result, taskId) => {
      removeTask(taskId);
      invalidate();
    },
  });

  const actions = {
    onRename: (taskId: string, title: string) => updateTaskMutation.mutate({ taskId, title }),
    onSetStatus: (taskId: string, status: 'done' | 'archived' | 'active') =>
      updateTaskMutation.mutate({ taskId, status }),
    onDelete: (taskId: string) => deleteTaskMutation.mutate(taskId),
  };

  const visibleSessions = useMemo(
    () => sessions.filter((session) => !session.archivedAt),
    [sessions],
  );

  const openTasks = useMemo(
    () =>
      tasks.filter((task) => task.status === 'active' || task.status === 'paused'),
    [tasks],
  );
  const closedTasks = useMemo(
    () => tasks.filter((task) => task.status === 'done' || task.status === 'archived'),
    [tasks],
  );
  const columnTasks = showClosed ? [...openTasks, ...closedTasks] : openTasks;

  const taskIds = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks]);

  const inboxSessions = useMemo(
    () =>
      sortSessions(
        visibleSessions.filter(
          (session) => session.taskId == null || !taskIds.has(session.taskId),
        ),
      ),
    [visibleSessions, taskIds],
  );

  const sessionsByTask = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of visibleSessions) {
      if (session.taskId == null || !taskIds.has(session.taskId)) continue;
      const list = map.get(session.taskId) ?? [];
      list.push(session);
      map.set(session.taskId, list);
    }
    for (const [key, list] of map) map.set(key, sortSessions(list));
    return map;
  }, [visibleSessions, taskIds]);

  const prsByTask = useMemo(() => {
    const map = new Map<string, PullRequest[]>();
    for (const pr of pullRequests) {
      if (pr.taskId == null) continue;
      const list = map.get(pr.taskId) ?? [];
      list.push(pr);
      map.set(pr.taskId, list);
    }
    return map;
  }, [pullRequests]);

  const handleLink = (sessionId: string, taskId: string | null) =>
    linkMutation.mutate({ sessionId, taskId });

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-4 py-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
          Board
        </span>
        {closedTasks.length > 0 && (
          <button
            type="button"
            onClick={() => setShowClosed((value) => !value)}
            className="font-mono text-[10.5px] text-faint hover:text-dim"
          >
            {showClosed ? '▾ hide' : '▸ show'} done/archived ({closedTasks.length})
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto px-4 pb-4">
        <TaskColumn
          task={null}
          sessions={inboxSessions}
          prs={[]}
          assignableTasks={openTasks}
          now={now}
          onOpenSession={onOpenSession}
          onLinkSession={handleLink}
          actions={actions}
        />
        {columnTasks.map((task) => (
          <TaskColumn
            key={task.id}
            task={task}
            sessions={sessionsByTask.get(task.id) ?? []}
            prs={prsByTask.get(task.id) ?? []}
            assignableTasks={openTasks}
            now={now}
            onOpenSession={onOpenSession}
            onLinkSession={handleLink}
            actions={actions}
          />
        ))}
        {openTasks.length === 0 && (
          <div className="flex w-[300px] shrink-0 items-center justify-center border border-dashed border-line text-center">
            <p className="px-6 font-mono text-[11px] leading-relaxed text-faint">
              No tasks yet.
              <br />
              Create one to start grouping sessions.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

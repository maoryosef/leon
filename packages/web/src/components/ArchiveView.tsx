import type { PullRequest, Session, Task } from '@leon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { deleteTask, updateTask } from '../lib/api';
import { relativeTime, useNow } from '../lib/time';
import { applyTask, removeTask, useBoardState } from '../lib/ws-store';

/**
 * Finished work, off the rail. The board carries only what's live; done and
 * archived tasks live here where they can be reviewed, reactivated or deleted
 * without competing for attention.
 */
export function ArchiveView() {
  const { tasks, sessions, pullRequests, jiraIssues, loaded } = useBoardState();
  const now = useNow();
  const queryClient = useQueryClient();

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['state'] });

  const statusMutation = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: Task['status'] }) =>
      updateTask(taskId, { status }),
    onSuccess: (task) => {
      applyTask(task);
      invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (taskId: string) => deleteTask(taskId),
    onSuccess: (_result, taskId) => {
      removeTask(taskId);
      invalidate();
    },
  });

  const jiraUrlByKey = useMemo(
    () => new Map(jiraIssues.map((issue) => [issue.key, issue.url])),
    [jiraIssues],
  );

  /** newest finish first — updatedAt is when the status flipped */
  const byFinishedAt = (a: Task, b: Task) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  const done = tasks.filter((task) => task.status === 'done').sort(byFinishedAt);
  const archived = tasks.filter((task) => task.status === 'archived').sort(byFinishedAt);

  const groups: { label: string; tasks: Task[]; empty: string }[] = [
    { label: `Done · ${done.length}`, tasks: done, empty: 'nothing finished yet' },
    { label: `Archived · ${archived.length}`, tasks: archived, empty: 'nothing archived' },
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-6">
        {!loaded ? (
          <p className="py-8 text-center font-mono text-[11px] text-faint">loading state…</p>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="flex flex-col gap-2">
              <h2 className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint select-none">
                {group.label}
              </h2>
              {group.tasks.length === 0 ? (
                <p className="border border-dashed border-line px-3 py-5 text-center font-mono text-[10.5px] text-faint">
                  {group.empty}
                </p>
              ) : (
                group.tasks.map((task) => (
                  <ArchiveRow
                    key={task.id}
                    task={task}
                    sessions={sessions.filter(
                      (session) => !session.archivedAt && session.taskId === task.id,
                    )}
                    prs={pullRequests.filter((pr) => pr.taskId === task.id)}
                    jiraUrl={task.jiraKey ? jiraUrlByKey.get(task.jiraKey) : undefined}
                    now={now}
                    busy={statusMutation.isPending || deleteMutation.isPending}
                    onReactivate={() =>
                      statusMutation.mutate({ taskId: task.id, status: 'active' })
                    }
                    onArchive={() =>
                      statusMutation.mutate({ taskId: task.id, status: 'archived' })
                    }
                    onDelete={() => {
                      if (
                        window.confirm(
                          `Delete task "${task.title}"? Sessions move back to Inbox.`,
                        )
                      ) {
                        deleteMutation.mutate(task.id);
                      }
                    }}
                  />
                ))
              )}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function ArchiveRow({
  task,
  sessions,
  prs,
  jiraUrl,
  now,
  busy,
  onReactivate,
  onArchive,
  onDelete,
}: {
  task: Task;
  sessions: Session[];
  prs: PullRequest[];
  jiraUrl?: string;
  now: number;
  busy: boolean;
  onReactivate: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const merged = prs.filter((pr) => pr.state === 'merged').length;
  const meta = [
    `${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
    ...(prs.length > 0
      ? [`${prs.length} PR${prs.length === 1 ? '' : 's'}${merged > 0 ? ` · ${merged} merged` : ''}`]
      : []),
    relativeTime(task.updatedAt, now),
  ].join(' · ');

  const action =
    'shrink-0 border border-line px-1.5 py-px font-mono text-[10px] text-faint hover:border-line-strong hover:text-txt disabled:opacity-40';

  return (
    <div className="group flex items-center gap-2.5 border border-line bg-panel px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate text-[13.5px] font-medium text-dim" title={task.title}>
            {task.title}
          </span>
          {task.jiraKey &&
            (jiraUrl ? (
              <a
                href={jiraUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex shrink-0 items-center gap-1 border border-info/40 px-1 py-px font-mono text-[9.5px] text-info/80 hover:border-info hover:text-info"
              >
                {task.jiraKey}
                <span aria-hidden>↗</span>
              </a>
            ) : (
              <span className="shrink-0 border border-info/30 px-1 py-px font-mono text-[9.5px] text-info/60">
                {task.jiraKey}
              </span>
            ))}
        </span>
        <span className="block font-mono text-[10px] text-faint">{meta}</span>
      </span>

      <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button type="button" disabled={busy} onClick={onReactivate} className={action}>
          reactivate
        </button>
        {task.status === 'done' && (
          <button type="button" disabled={busy} onClick={onArchive} className={action}>
            archive
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onDelete}
          className={`${action} hover:border-danger/60 hover:text-danger`}
        >
          delete
        </button>
      </div>
    </div>
  );
}

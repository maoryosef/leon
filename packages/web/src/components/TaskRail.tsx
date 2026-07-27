import type { PullRequest, Session, SessionStatus, Task, TaskStatus } from '@leon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { deleteTask, linkSession, refreshJira, updateTask } from '../lib/api';
import { sessionTitle } from '../lib/format';
import {
  applySession,
  applyTask,
  removeTask,
  setOpenSession,
  useBoardState,
} from '../lib/ws-store';
import { NewTaskForm } from './NewTaskForm';
import { StatusBadge } from './StatusBadge';

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

interface TaskActions {
  onRename: (taskId: string, title: string) => void;
  onSetStatus: (taskId: string, status: 'done' | 'archived' | 'active') => void;
  onDelete: (taskId: string) => void;
}

function TaskMenu({
  task,
  actions,
  onRenameStart,
}: {
  task: Task;
  actions: TaskActions;
  onRenameStart: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const item =
    'block w-full px-2.5 py-1.5 text-left text-[11px] text-dim hover:bg-raise hover:text-txt';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={`Task menu: ${task.title}`}
        onClick={() => setOpen((value) => !value)}
        className="px-1.5 py-0.5 font-mono text-[13px] leading-none text-faint hover:text-txt"
      >
        ⋮
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-36 border border-line-strong bg-panel py-1 shadow-[0_4px_16px_rgba(0,0,0,0.6)]">
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              onRenameStart();
            }}
          >
            Rename
          </button>
          {task.status !== 'done' ? (
            <button
              type="button"
              className={item}
              onClick={() => {
                setOpen(false);
                actions.onSetStatus(task.id, 'done');
              }}
            >
              Mark done
            </button>
          ) : (
            <button
              type="button"
              className={item}
              onClick={() => {
                setOpen(false);
                actions.onSetStatus(task.id, 'active');
              }}
            >
              Reactivate
            </button>
          )}
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              actions.onSetStatus(task.id, 'archived');
            }}
          >
            Archive
          </button>
          <button
            type="button"
            className={`${item} text-danger/80 hover:text-danger`}
            onClick={() => {
              setOpen(false);
              if (window.confirm(`Delete task "${task.title}"? Sessions move back to Inbox.`)) {
                actions.onDelete(task.id);
              }
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/** Compact one-line session row for the rail (task expansion + inbox). */
function SessionRow({
  session,
  assignableTasks,
  onLink,
}: {
  session: Session;
  assignableTasks: Task[];
  onLink: (sessionId: string, taskId: string | null) => void;
}) {
  const dead = session.status === 'dead';
  return (
    <div
      className={`group flex flex-col gap-1 border border-line bg-panel px-1.5 py-1 ${
        dead ? 'opacity-45 hover:opacity-70' : ''
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={`min-w-0 flex-1 truncate text-[11.5px] ${dead ? 'text-dim' : 'text-txt'}`}
          title={session.cwd}
        >
          {sessionTitle(session)}
        </span>
        <StatusBadge status={session.status} source={session.statusSource} />
        <button
          type="button"
          title="Peek terminal"
          onClick={() => setOpenSession(session.id)}
          className="shrink-0 border border-line px-1 py-px font-mono text-[10.5px] text-dim hover:border-line-strong hover:text-txt"
        >
          ›
        </button>
      </div>
      {!dead && (
        <select
          aria-label="Assign to task"
          value={session.taskId ?? ''}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            const value = event.target.value;
            onLink(session.id, value === '' ? null : value);
          }}
          className="w-full cursor-pointer border border-line bg-bg px-1 py-0.5 font-mono text-[10.5px] text-dim opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:border-line-strong"
        >
          <option value="">→ Inbox</option>
          {assignableTasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** One PR as a compact pill — the leaf of the task → session → PR tree. */
function PrPill({ pr }: { pr: PullRequest }) {
  const dot =
    pr.checks === 'failing'
      ? 'bg-danger'
      : pr.checks === 'passing'
        ? 'bg-ok'
        : pr.checks === 'pending'
          ? 'bg-accent'
          : 'bg-faint';
  const done = pr.state === 'merged' || pr.state === 'closed';
  const right = done
    ? pr.state
    : pr.reviewDecision === 'approved'
      ? '✓ approved'
      : pr.reviewDecision === 'changes_requested'
        ? '✗ changes'
        : pr.checks === 'failing'
          ? '✗ checks'
          : pr.checks === 'pending'
            ? 'checks…'
            : pr.reviewDecision === 'review_required'
              ? 'review req.'
              : '';
  const rightClass =
    right.startsWith('✓') ? 'text-ok' : right.startsWith('✗') ? 'text-danger' : 'text-faint';
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      title={`${pr.title} · ${pr.state} · checks ${pr.checks}`}
      className={`flex items-center gap-1.5 border border-line bg-panel px-1.5 py-1 font-mono text-[10.5px] hover:border-line-strong ${
        done ? 'opacity-50' : ''
      }`}
    >
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="shrink-0 text-txt">#{pr.number}</span>
      <span className="min-w-0 truncate text-dim">{pr.title}</span>
      {right && <span className={`ml-auto shrink-0 ${rightClass}`}>{right}</span>}
    </a>
  );
}

/** "PR ✓/✗" glyph for a task's linked PRs — omitted when nothing is decisive. */
function prGlyphFor(prs: PullRequest[]): { symbol: string; className: string } | null {
  if (prs.length === 0) return null;
  const failing = prs.some(
    (pr) => pr.checks === 'failing' || pr.reviewDecision === 'changes_requested',
  );
  if (failing) return { symbol: '✗', className: 'text-danger' };
  const good = prs.some((pr) => pr.checks === 'passing' || pr.reviewDecision === 'approved');
  if (good) return { symbol: '✓', className: 'text-ok' };
  return null;
}

function TaskCard({
  task,
  sessions,
  prs,
  assignableTasks,
  expanded,
  onToggle,
  actions,
  onLink,
}: {
  task: Task;
  sessions: Session[];
  prs: PullRequest[];
  assignableTasks: Task[];
  expanded: boolean;
  onToggle: () => void;
  actions: TaskActions;
  onLink: (sessionId: string, taskId: string | null) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const commitRename = () => {
    setRenaming(false);
    if (draft.trim() && draft.trim() !== task.title) {
      actions.onRename(task.id, draft.trim());
    }
  };

  const needsYou = sessions.filter(
    (session) =>
      session.status === 'waiting_permission' || session.status === 'waiting_input',
  ).length;
  const anyWorking = sessions.some((session) => session.status === 'working');
  const allIdle =
    sessions.length > 0 && sessions.every((session) => session.status === 'idle_done');
  const dot =
    needsYou > 0 ? 'bg-accent' : anyWorking ? 'bg-ok' : allIdle ? 'bg-info' : 'bg-faint';

  const prGlyph = prGlyphFor(prs);
  const muted = task.status === 'done' || task.status === 'archived';

  return (
    <div
      className={`shrink-0 border bg-bg ${needsYou > 0 ? 'border-accent/40' : 'border-line'} ${
        muted ? 'opacity-60' : ''
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-col gap-1 px-2 py-1.5 text-left hover:bg-raise"
      >
        <div className="flex w-full items-center gap-1.5">
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dot}`} />
          <span className="min-w-0 truncate text-[12px] font-medium text-txt" title={task.title}>
            {task.title}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
            {expanded ? '▾' : '▸'}
          </span>
        </div>
        <div className="flex items-center gap-1 font-mono text-[10px] text-faint">
          <span>
            {sessions.length} session{sessions.length === 1 ? '' : 's'}
          </span>
          {needsYou > 0 && (
            <>
              <span>·</span>
              <span className="text-accent">{needsYou} needs you</span>
            </>
          )}
          {prGlyph && (
            <>
              <span>·</span>
              <span className={prGlyph.className}>PR {prGlyph.symbol}</span>
            </>
          )}
        </div>
      </button>

      {expanded && (
        <div className="flex flex-col gap-1.5 border-t border-line p-1.5">
          <div className="flex min-h-6 items-center gap-1.5 px-0.5">
            {renaming ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitRename();
                  if (event.key === 'Escape') setRenaming(false);
                }}
                className="w-full border border-line-strong bg-bg px-1 py-0.5 text-[11.5px] text-txt outline-none"
              />
            ) : (
              <>
                {task.jiraKey && (
                  <span className="shrink-0 border border-line-strong px-1 py-px font-mono text-[9.5px] text-dim">
                    {task.jiraKey}
                  </span>
                )}
                <span className="font-mono text-[9.5px] uppercase text-faint">{task.status}</span>
                <span className="ml-auto" />
                <TaskMenu
                  task={task}
                  actions={actions}
                  onRenameStart={() => {
                    setDraft(task.title);
                    setRenaming(true);
                  }}
                />
              </>
            )}
          </div>

          {sessions.length === 0 && prs.length === 0 ? (
            <p className="px-1 py-1.5 text-center font-mono text-[10.5px] text-faint">
              no sessions
            </p>
          ) : (
            <>
              {sessions.map((session) => {
                const sessionPrs = prs.filter((pr) => pr.sessionId === session.id);
                return (
                  <div key={session.id} className="flex flex-col">
                    <SessionRow
                      session={session}
                      assignableTasks={assignableTasks}
                      onLink={onLink}
                    />
                    {/* the session's output: its PR(s), or the empty slot */}
                    <div className="ml-2.5 flex flex-col gap-1 border-l border-line pt-1 pl-2">
                      {sessionPrs.length > 0 ? (
                        sessionPrs.map((pr) => <PrPill key={pr.id} pr={pr} />)
                      ) : session.status !== 'dead' ? (
                        <span className="px-0.5 font-mono text-[9.5px] text-faint">
                          no PR yet
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {/* task-level PRs whose session is gone/unknown */}
              {prs.filter((pr) => !sessions.some((s) => s.id === pr.sessionId)).length > 0 && (
                <div className="mt-0.5 flex flex-col gap-1 border-t border-line/60 pt-1.5">
                  {prs
                    .filter((pr) => !sessions.some((s) => s.id === pr.sessionId))
                    .map((pr) => (
                      <PrPill key={pr.id} pr={pr} />
                    ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskRail({
  tasks,
  sessions,
  pullRequests,
  loaded,
  loadFailed,
  mobileOpen,
}: {
  tasks: Task[];
  sessions: Session[];
  pullRequests: PullRequest[];
  loaded: boolean;
  /** REST seed failed and the socket is down — show the unreachable hint. */
  loadFailed: boolean;
  /** below 1100px the rail is an overlay drawer; this is its open state */
  mobileOpen: boolean;
}) {
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
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
    mutationFn: ({
      taskId,
      title,
      status,
    }: {
      taskId: string;
      title?: string;
      status?: TaskStatus;
    }) => updateTask(taskId, { ...(title ? { title } : {}), ...(status ? { status } : {}) }),
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

  const actions: TaskActions = {
    onRename: (taskId, title) => updateTaskMutation.mutate({ taskId, title }),
    onSetStatus: (taskId, status) => updateTaskMutation.mutate({ taskId, status }),
    onDelete: (taskId) => deleteTaskMutation.mutate(taskId),
  };

  const handleLink = (sessionId: string, taskId: string | null) =>
    linkMutation.mutate({ sessionId, taskId });

  const visibleSessions = useMemo(
    () => sessions.filter((session) => !session.archivedAt),
    [sessions],
  );

  const openTasks = useMemo(
    () => tasks.filter((task) => task.status === 'active' || task.status === 'paused'),
    [tasks],
  );
  const closedTasks = useMemo(
    () => tasks.filter((task) => task.status === 'done' || task.status === 'archived'),
    [tasks],
  );
  const railTasks = showClosed ? [...openTasks, ...closedTasks] : openTasks;

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
      if (pr.state === 'merged' || pr.state === 'closed') continue; // finished business
      const list = map.get(pr.taskId) ?? [];
      list.push(pr);
      map.set(pr.taskId, list);
    }
    return map;
  }, [pullRequests]);

  return (
    <aside
      className={`flex w-[250px] shrink-0 flex-col border-r border-line bg-panel ${
        mobileOpen
          ? 'max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:left-7 max-[1100px]:z-20 max-[1100px]:shadow-[12px_0_40px_rgba(0,0,0,0.7)]'
          : 'max-[1100px]:hidden'
      }`}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint select-none">
          Tasks
        </span>
        <button
          type="button"
          onClick={() => setNewTaskOpen(true)}
          className="border border-line-strong bg-raise px-1.5 py-px font-mono text-[10.5px] text-dim hover:border-dim hover:text-txt"
        >
          + new
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
        {!loaded ? (
          <p className="px-2 py-4 text-center font-mono text-[10.5px] text-faint">
            {loadFailed ? 'daemon unreachable — retrying…' : 'loading state…'}
          </p>
        ) : (
          <>
            {railTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                sessions={sessionsByTask.get(task.id) ?? []}
                prs={prsByTask.get(task.id) ?? []}
                assignableTasks={openTasks}
                expanded={expandedTaskId === task.id}
                onToggle={() =>
                  setExpandedTaskId((current) => (current === task.id ? null : task.id))
                }
                actions={actions}
                onLink={handleLink}
              />
            ))}

            {openTasks.length === 0 && (
              <div className="border border-dashed border-line px-3 py-4 text-center">
                <p className="font-mono text-[10.5px] leading-relaxed text-faint">
                  No tasks yet.
                  <br />
                  Create one to start grouping sessions.
                </p>
              </div>
            )}

            {closedTasks.length > 0 && (
              <button
                type="button"
                onClick={() => setShowClosed((value) => !value)}
                className="mt-1 self-start px-0.5 font-mono text-[10.5px] text-faint hover:text-dim"
              >
                {showClosed ? '▾ hide' : '▸ show'} done/archived ({closedTasks.length})
              </button>
            )}
          </>
        )}
      </div>

      <JiraSection />

      <div className="shrink-0 border-t border-line">
        <button
          type="button"
          onClick={() => setInboxOpen((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 hover:bg-raise"
        >
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint select-none">
            Inbox · {inboxSessions.length}
          </span>
          <span className="ml-auto font-mono text-[10px] text-faint">
            {inboxOpen ? '▾' : '▸'}
          </span>
        </button>
        {inboxOpen && (
          <div className="flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto px-2 pb-2">
            {inboxSessions.length === 0 ? (
              <p className="py-2 text-center font-mono text-[10.5px] text-faint">
                no unassigned sessions
              </p>
            ) : (
              inboxSessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  assignableTasks={openTasks}
                  onLink={handleLink}
                />
              ))
            )}
          </div>
        )}
      </div>

      {newTaskOpen && <NewTaskForm onClose={() => setNewTaskOpen(false)} />}
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* JIRA — the user's assigned issues, synced into a local cache by     */
/* Leon's agent (it holds the Atlassian auth). Read-only rail section.  */
/* ------------------------------------------------------------------ */

function jiraDot(statusCategory: string | null | undefined): string {
  switch ((statusCategory ?? '').toLowerCase()) {
    case 'in progress':
      return 'bg-ok';
    case 'to do':
      return 'bg-info';
    default:
      return 'bg-faint';
  }
}

function JiraSection() {
  const { jiraIssues } = useBoardState();
  const [open, setOpen] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    refreshJira()
      .catch(() => undefined)
      // the agent takes a few seconds; jira.synced over WS updates the list
      .finally(() => window.setTimeout(() => setRefreshing(false), 8000));
  };

  return (
    <div className="shrink-0 border-t border-line">
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex flex-1 items-center gap-2 text-left hover:text-dim"
        >
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint select-none">
            Jira · {jiraIssues.length}
          </span>
          <span className="ml-auto font-mono text-[10px] text-faint">{open ? '▾' : '▸'}</span>
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          title="Ask Leon to re-sync from Jira"
          className={`border border-line-strong bg-raise px-1.5 py-px font-mono text-[10.5px] text-dim hover:border-dim hover:text-txt disabled:opacity-40 ${
            refreshing ? 'throb' : ''
          }`}
        >
          ↻
        </button>
      </div>
      {open && (
        <div className="flex max-h-[38vh] flex-col overflow-y-auto px-2 pb-2">
          {jiraIssues.length === 0 ? (
            <p className="py-2 text-center font-mono text-[10.5px] text-faint">
              {refreshing ? 'Leon is syncing…' : 'nothing synced yet — hit ↻'}
            </p>
          ) : (
            jiraIssues.map((issue) => (
              <a
                key={issue.key}
                href={issue.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`${issue.summary}\n${issue.status}${issue.priority ? ` · ${issue.priority}` : ''}`}
                className="group flex items-center gap-2 border-b border-line/60 px-1.5 py-1.5 last:border-b-0 hover:bg-raise"
              >
                <span className={`size-1.5 shrink-0 rounded-full ${jiraDot(issue.statusCategory)}`} />
                <span className="shrink-0 font-mono text-[10.5px] text-dim group-hover:text-txt">
                  {issue.key}
                </span>
                <span className="truncate text-[11.5px] text-dim">{issue.summary}</span>
              </a>
            ))
          )}
        </div>
      )}
    </div>
  );
}

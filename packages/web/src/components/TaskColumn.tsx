import type { PrChecks, PullRequest, Session, Task } from '@leon/shared';
import { useEffect, useRef, useState } from 'react';
import { SessionCard } from './SessionCard';

const PR_SYMBOL: Record<PrChecks, string> = {
  passing: '✓',
  failing: '✗',
  pending: '●',
  none: '○',
};

const PR_COLOR: Record<PrChecks, string> = {
  passing: 'text-ok border-ok/40',
  failing: 'text-danger border-danger/40',
  pending: 'text-dim border-line-strong',
  none: 'text-faint border-line',
};

function PrChips({ prs }: { prs: PullRequest[] }) {
  if (prs.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {prs.map((pr) => (
        <a
          key={pr.id}
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          title={`${pr.title} · ${pr.state} · checks ${pr.checks}`}
          className={`border px-1 py-px font-mono text-[10px] hover:bg-raise ${PR_COLOR[pr.checks]} ${
            pr.state === 'merged' || pr.state === 'closed' ? 'opacity-50' : ''
          }`}
        >
          #{pr.number} {PR_SYMBOL[pr.checks]}
        </a>
      ))}
    </div>
  );
}

interface TaskActions {
  onRename: (taskId: string, title: string) => void;
  onSetStatus: (taskId: string, status: 'done' | 'archived' | 'active') => void;
  onDelete: (taskId: string) => void;
}

function TaskMenu({ task, actions, onRenameStart }: {
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

export function TaskColumn({
  task,
  sessions,
  prs,
  assignableTasks,
  now,
  onOpenSession,
  onLinkSession,
  actions,
}: {
  /** null = the Inbox column */
  task: Task | null;
  sessions: Session[];
  prs: PullRequest[];
  assignableTasks: Task[];
  now: number;
  onOpenSession: (session: Session) => void;
  onLinkSession: (sessionId: string, taskId: string | null) => void;
  actions: TaskActions;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const commitRename = () => {
    setRenaming(false);
    if (task && draft.trim() && draft.trim() !== task.title) {
      actions.onRename(task.id, draft.trim());
    }
  };

  const muted = task != null && (task.status === 'done' || task.status === 'archived');

  return (
    <section
      className={`flex w-[300px] shrink-0 flex-col border border-line bg-bg ${muted ? 'opacity-60' : ''}`}
    >
      <header className="flex flex-col gap-1.5 border-b border-line bg-panel px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          {task == null ? (
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
              Inbox
            </span>
          ) : renaming ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitRename();
                if (event.key === 'Escape') setRenaming(false);
              }}
              className="w-full border border-line-strong bg-bg px-1 py-0.5 text-[12px] text-txt outline-none"
            />
          ) : (
            <span className="truncate text-[12px] font-semibold text-txt" title={task.title}>
              {task.title}
            </span>
          )}

          {task?.jiraKey && (
            <span className="shrink-0 border border-line-strong px-1 py-px font-mono text-[9.5px] text-dim">
              {task.jiraKey}
            </span>
          )}
          {muted && (
            <span className="shrink-0 font-mono text-[9.5px] uppercase text-faint">
              {task.status}
            </span>
          )}

          <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
            {sessions.length}
          </span>
          {task && (
            <TaskMenu
              task={task}
              actions={actions}
              onRenameStart={() => {
                setDraft(task.title);
                setRenaming(true);
              }}
            />
          )}
        </div>
        <PrChips prs={prs} />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
        {sessions.length === 0 && (
          <div className="px-1 py-3 text-center font-mono text-[10.5px] text-faint">
            {task == null ? 'no unassigned sessions' : 'no sessions'}
          </div>
        )}
        {sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            tasks={assignableTasks}
            now={now}
            onOpen={onOpenSession}
            onLink={onLinkSession}
          />
        ))}
      </div>
    </section>
  );
}

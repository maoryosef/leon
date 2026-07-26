import type { Session, SessionStatus, Task } from '@leon/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sessionTitle, tmuxTarget } from '../lib/format';
import { relativeTime, useNow } from '../lib/time';
import { TermView } from './TermView';
import type { TermConn, TermViewHandle } from './TermView';

/* mirrors the StatusBadge dot colors (amber = attention) */
const DOT: Record<SessionStatus, string> = {
  working: 'bg-ok throb',
  waiting_permission: 'bg-accent attn-pulse',
  waiting_input: 'bg-accent/80',
  idle_done: 'bg-info/80',
  dead: 'bg-faint',
  unknown: 'bg-faint',
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  working: 'WORKING',
  waiting_permission: 'NEEDS YOU',
  waiting_input: 'WAITING',
  idle_done: 'IDLE',
  dead: 'DEAD',
  unknown: 'UNKNOWN',
};

const STATUS_ORDER: Record<SessionStatus, number> = {
  waiting_permission: 0,
  waiting_input: 1,
  working: 2,
  idle_done: 3,
  unknown: 4,
  dead: 5,
};

/** waiting_* = oldest wait first (most urgent); everything else newest first. */
function sortForList(sessions: Session[]): Session[] {
  return sessions.slice().sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.status === 'waiting_permission' || a.status === 'waiting_input') {
      return Date.parse(a.statusSince) - Date.parse(b.statusSince);
    }
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  });
}

function SessionRow({
  session,
  selected,
  taskTitle,
  now,
  onSelect,
}: {
  session: Session;
  selected: boolean;
  taskTitle: string | null;
  now: number;
  onSelect: () => void;
}) {
  const dead = session.status === 'dead';
  const meta = [
    STATUS_LABEL[session.status],
    relativeTime(session.statusSince, now),
    taskTitle ?? 'inbox',
    ...(session.status === 'working' && session.currentActivity ? [session.currentActivity] : []),
  ].join(' · ');

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex shrink-0 flex-col gap-0.5 border px-2 py-1.5 text-left ${
        selected
          ? 'border-line-strong bg-raise shadow-[inset_2px_0_0_0_var(--color-accent)]'
          : 'border-line bg-bg hover:bg-raise'
      } ${dead ? 'opacity-45' : ''}`}
    >
      <span className="flex w-full items-center gap-1.5">
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${DOT[session.status]}`} />
        <span
          className={`min-w-0 flex-1 truncate text-[12px] font-semibold ${dead ? 'text-dim' : 'text-txt'}`}
          title={session.cwd}
        >
          {sessionTitle(session)}
        </span>
        {selected && !dead && (
          <span className="shrink-0 border border-accent/60 bg-accent/10 px-1 py-px font-mono text-[9px] font-bold tracking-[0.08em] text-accent select-none">
            LIVE
          </span>
        )}
      </span>
      <span className="truncate font-mono text-[10px] text-dim" title={meta}>
        {meta}
      </span>
    </button>
  );
}

export function SessionsView({
  sessions,
  tasks,
  modalOpen,
}: {
  sessions: Session[];
  tasks: Task[];
  /** the terminal modal is stacked on top — suspend list keyboard handling */
  modalOpen: boolean;
}) {
  const now = useNow(10_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewOnly, setViewOnly] = useState(false);
  const [conn, setConn] = useState<TermConn>('connecting');
  const [copied, setCopied] = useState(false);

  const termHandleRef = useRef<TermViewHandle>(null);
  const termWrapRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () => sortForList(sessions.filter((session) => !session.archivedAt)),
    [sessions],
  );
  const taskTitleById = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);

  // Default selection = first row; fall back there if the selected row vanishes.
  const selected = rows.find((session) => session.id === selectedId) ?? rows[0];

  /* list keyboard: ↑/↓ select, ⏎ focus terminal, esc back out of the terminal */
  useEffect(() => {
    if (modalOpen) return;

    const focusInTerm = () => {
      const active = document.activeElement;
      return active != null && termWrapRef.current?.contains(active) === true;
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // capture phase — beat xterm to it so esc blurs instead of hitting the pane
        if (focusInTerm()) {
          event.preventDefault();
          event.stopPropagation();
          termHandleRef.current?.blur();
        }
        return;
      }
      if (focusInTerm()) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedId((current) => {
          const index = rows.findIndex(
            (session) => session.id === (current ?? rows[0]?.id ?? null),
          );
          const next = Math.min(
            rows.length - 1,
            Math.max(0, (index === -1 ? 0 : index) + (event.key === 'ArrowUp' ? -1 : 1)),
          );
          return rows[next]?.id ?? current;
        });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        termHandleRef.current?.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rows, modalOpen]);

  const copyAttachCmd = (session: Session) => {
    void navigator.clipboard.writeText(`tmux attach -t '${session.tmuxSessionName}'`).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };

  if (rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <p className="font-mono text-[11px] text-faint">
          no sessions — start one in tmux and it will show up here
        </p>
      </div>
    );
  }

  const selectedDead = selected?.status === 'dead';

  return (
    <div className="flex min-h-0 flex-1">
      {/* ---------------------------------------------------------- list */}
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="shrink-0 border-b border-line px-3 py-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint select-none">
            Sessions · {rows.length}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5">
          {rows.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={selected?.id === session.id}
              taskTitle={session.taskId != null ? (taskTitleById.get(session.taskId) ?? null) : null}
              now={now}
              onSelect={() => setSelectedId(session.id)}
            />
          ))}
        </div>

        <div className="shrink-0 border-t border-line px-3 py-1.5 font-mono text-[10px] text-faint select-none">
          ↑↓ switch · ⏎ focus · esc back
        </div>
      </aside>

      {/* ------------------------------------------------------ terminal */}
      <section className="flex min-w-0 flex-1 flex-col bg-bg">
        {selected && (
          <>
            <div
              className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 ${
                selectedDead || viewOnly ? 'border-line bg-panel' : 'border-danger/60 bg-danger/10'
              }`}
            >
              {selectedDead ? (
                <span className="font-mono text-[10.5px] tracking-[0.1em] text-faint select-none">
                  SESSION DEAD
                </span>
              ) : viewOnly ? (
                <span className="font-mono text-[10.5px] tracking-[0.1em] text-dim select-none">
                  VIEW ONLY — input off
                </span>
              ) : (
                <>
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-danger throb" />
                  <span className="font-mono text-[10.5px] font-bold tracking-[0.1em] text-danger select-none">
                    ATTACHED — KEYSTROKES ARE LIVE
                  </span>
                </>
              )}
              {!selectedDead && conn !== 'open' && (
                <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                  {conn === 'connecting' ? 'connecting…' : 'stream closed'}
                </span>
              )}

              <div className="ml-auto flex min-w-0 items-center gap-2">
                <span className="truncate text-[11.5px] font-medium text-txt" title={selected.cwd}>
                  {sessionTitle(selected)}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-faint">
                  {tmuxTarget(selected)}
                </span>
                {!selectedDead && (
                  <>
                    <button
                      type="button"
                      onClick={() => setViewOnly((value) => !value)}
                      className={
                        viewOnly
                          ? 'shrink-0 border border-accent/60 bg-accent/10 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-accent hover:bg-accent/20'
                          : 'shrink-0 border border-line-strong bg-raise px-2 py-0.5 font-mono text-[10.5px] text-dim hover:border-dim hover:text-txt'
                      }
                    >
                      {viewOnly ? 'attach' : 'view only'}
                    </button>
                    <button
                      type="button"
                      onClick={() => copyAttachCmd(selected)}
                      className="shrink-0 border border-line-strong bg-raise px-2 py-0.5 font-mono text-[10.5px] text-dim hover:border-dim hover:text-txt"
                    >
                      {copied ? 'copied' : 'copy attach cmd'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {selectedDead ? (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <p className="font-mono text-[11px] text-faint">
                  session is dead — nothing to attach to
                </p>
              </div>
            ) : (
              <div ref={termWrapRef} className="min-h-0 flex-1 p-2">
                <TermView
                  ref={termHandleRef}
                  session={selected}
                  mode={viewOnly ? 'view' : 'attach'}
                  onConnChange={setConn}
                />
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

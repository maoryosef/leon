import type { Session, SessionStatus, Task } from '@leon/shared';
import { sessionTitle, tmuxTarget, truncateMiddle } from '../lib/format';
import { relativeTime } from '../lib/time';
import { StatusBadge } from './StatusBadge';

const RAIL: Record<SessionStatus, string> = {
  working: 'border-l-ok',
  waiting_permission: 'border-l-accent',
  waiting_input: 'border-l-accent/50',
  idle_done: 'border-l-info/60',
  dead: 'border-l-line',
  unknown: 'border-l-line-strong',
};

export function SessionCard({
  session,
  tasks,
  now,
  onOpen,
  onLink,
}: {
  session: Session;
  tasks: Task[];
  now: number;
  onOpen: (session: Session) => void;
  onLink: (sessionId: string, taskId: string | null) => void;
}) {
  const dead = session.status === 'dead';
  const title = sessionTitle(session);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(session)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) onOpen(session);
      }}
      className={`group cursor-pointer border border-l-2 border-line bg-panel transition-colors hover:border-line-strong hover:bg-raise ${RAIL[session.status]} ${
        dead ? 'opacity-45 hover:opacity-70' : ''
      }`}
    >
      <div className={`flex flex-col gap-1 px-2.5 ${dead ? 'py-1.5' : 'py-2'}`}>
        <div className="flex items-center justify-between gap-2">
          <span className={`truncate text-[12.5px] font-medium ${dead ? 'text-dim' : 'text-txt'}`}>
            {title}
          </span>
          <StatusBadge status={session.status} source={session.statusSource} />
        </div>

        <div className="truncate font-mono text-[10.5px] text-faint" title={session.cwd}>
          {truncateMiddle(session.cwd, 40)}
        </div>

        {!dead && session.currentActivity && (
          <div className="truncate font-mono text-[10.5px] text-dim">
            <span className="text-faint">▸ </span>
            {session.currentActivity}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-0.5">
          <span className="truncate font-mono text-[10px] text-faint" title="tmux target">
            {tmuxTarget(session)}
          </span>
          <span
            className="shrink-0 font-mono text-[10px] text-faint"
            title={`last activity ${session.lastActivityAt}`}
          >
            {relativeTime(session.lastActivityAt, now)}
          </span>
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
            className="mt-0.5 w-full cursor-pointer border border-line bg-bg px-1 py-0.5 font-mono text-[10.5px] text-dim opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:border-line-strong"
          >
            <option value="">→ Inbox</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

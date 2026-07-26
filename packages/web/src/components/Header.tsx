import type { Approval, Session } from '@leon/shared';
import { useState } from 'react';
import type { ConnectionStatus, View } from '../lib/ws-store';
import { setView } from '../lib/ws-store';

/** The man himself — packages/web/public/leon.png (swap the file to change it). */
function LeonAvatar() {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src="/leon.png"
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
      className="size-7 rounded-md object-cover select-none"
    />
  );
}

function connectionMeta(connection: ConnectionStatus): { className: string; label: string } {
  switch (connection) {
    case 'connected':
      return { className: 'bg-ok', label: 'live' };
    case 'connecting':
      return { className: 'bg-dim throb', label: 'connecting' };
    case 'reconnecting':
      return { className: 'bg-accent throb', label: 'reconnecting' };
  }
}

const VIEWS: { view: View; label: string }[] = [
  { view: 'board', label: 'BOARD' },
  { view: 'sessions', label: 'SESSIONS' },
];

export function Header({
  connection,
  sessions,
  approvals,
  view,
}: {
  connection: ConnectionStatus;
  sessions: Session[];
  approvals: Approval[];
  view: View;
}) {
  const live = sessions.filter((session) => !session.archivedAt);
  const working = live.filter((session) => session.status === 'working').length;
  const needsYou = live.filter(
    (session) =>
      session.status === 'waiting_permission' || session.status === 'waiting_input',
  ).length;
  const idle = live.filter((session) => session.status === 'idle_done').length;

  const counts: string[] = [];
  if (working > 0) counts.push(`${working} working`);
  if (needsYou > 0) counts.push(`${needsYou} needs you`);
  if (idle > 0) counts.push(`${idle} idle`);
  if (counts.length === 0) counts.push(`${live.length} sessions`);

  const conn = connectionMeta(connection);
  const pendingApprovals = approvals.length;

  return (
    <header className="flex h-11 shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
      <div className="flex items-center gap-2.5">
        <LeonAvatar />
        <span className="font-mono text-sm font-bold tracking-[0.3em] text-accent select-none">
          LEON
        </span>
        <span
          title={`events socket: ${conn.label}`}
          className={`size-2 rounded-full ${conn.className}`}
        />
      </div>

      <nav className="flex items-stretch gap-1 self-stretch" aria-label="View">
        {VIEWS.map((tab) => (
          <button
            key={tab.view}
            type="button"
            onClick={() => setView(tab.view)}
            className={`border-b-2 px-2 font-mono text-[10.5px] tracking-[0.14em] select-none ${
              view === tab.view
                ? 'border-accent text-txt'
                : 'border-transparent text-faint hover:text-dim'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <span className="font-mono text-[11px] text-dim">{counts.join(' · ')}</span>

      {pendingApprovals > 0 && (
        <span
          title={`${pendingApprovals} approvals`}
          className="border border-line-strong px-1.5 py-px font-mono text-[10px] text-dim"
        >
          approvals {pendingApprovals}
        </span>
      )}
    </header>
  );
}

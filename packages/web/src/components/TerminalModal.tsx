import type { Session } from '@leon/shared';
import { useEffect, useState } from 'react';
import { sessionTitle, tmuxTarget } from '../lib/format';
import { StatusBadge } from './StatusBadge';
import { TermView } from './TermView';
import type { TermConn } from './TermView';

/**
 * Board-view terminal overlay. Opens DIRECTLY attached (keystrokes live) with
 * a client-side "view only" toggle — same banner idiom as SessionsView.
 */
export function TerminalModal({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const [viewOnly, setViewOnly] = useState(false);
  const [conn, setConn] = useState<TermConn>('connecting');
  const [copied, setCopied] = useState(false);

  /* Esc closes — only in view-only mode; attached keystrokes belong to the pane */
  useEffect(() => {
    if (!viewOnly) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewOnly, onClose]);

  const copyAttachCmd = () => {
    void navigator.clipboard
      .writeText(`tmux attach -t '${session.tmuxSessionName}'`)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-[80vh] w-[85vw] flex-col border border-line-strong bg-bg shadow-[0_8px_40px_rgba(0,0,0,0.8)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-3 py-2">
          <span className="truncate text-[12.5px] font-medium text-txt">
            {sessionTitle(session)}
          </span>
          <span className="font-mono text-[10.5px] text-faint">{tmuxTarget(session)}</span>
          <StatusBadge status={session.status} source={session.statusSource} />
          {conn !== 'open' && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
              {conn === 'connecting' ? 'connecting…' : 'stream closed'}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={copyAttachCmd}
              className="border border-line-strong bg-raise px-2 py-1 font-mono text-[10.5px] text-dim hover:border-dim hover:text-txt"
            >
              {copied ? 'copied' : 'copy attach cmd'}
            </button>
            <button
              type="button"
              onClick={() => setViewOnly((value) => !value)}
              className={
                viewOnly
                  ? 'border border-accent/60 bg-accent/10 px-2 py-1 font-mono text-[10.5px] font-semibold text-accent hover:bg-accent/20'
                  : 'border border-line-strong bg-raise px-2 py-1 font-mono text-[10.5px] text-dim hover:border-dim hover:text-txt'
              }
            >
              {viewOnly ? 'attach' : 'view only'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close terminal"
              className="border border-line-strong bg-raise px-2 py-1 font-mono text-[10.5px] text-dim hover:border-dim hover:text-txt"
            >
              ✕
            </button>
          </div>
        </header>

        <div
          className={`flex shrink-0 items-center gap-2 border-b px-3 py-1 ${
            viewOnly ? 'border-line bg-panel' : 'border-danger/60 bg-danger/10'
          }`}
        >
          {viewOnly ? (
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
        </div>

        <div className="min-h-0 flex-1 bg-bg p-2">
          <TermView
            session={session}
            mode={viewOnly ? 'view' : 'attach'}
            onConnChange={setConn}
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}

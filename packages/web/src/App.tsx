import type { Session } from '@leon/shared';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { AttentionDock } from './components/AttentionDock';
import { ChatPanel } from './components/ChatPanel';
import { Header } from './components/Header';
import { TaskRail } from './components/TaskRail';

// xterm is heavy — split both terminal surfaces out so the console loads lean.
const TerminalModal = lazy(() =>
  import('./components/TerminalModal').then((module) => ({ default: module.TerminalModal })),
);
const SessionsView = lazy(() =>
  import('./components/SessionsView').then((module) => ({ default: module.SessionsView })),
);
import { fetchState, useUnauthorized } from './lib/api';
import { seedFromRest, setOpenSession, startEvents, useBoardState } from './lib/ws-store';

function UnauthorizedScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <span className="font-mono text-sm font-bold tracking-[0.3em] text-accent select-none">
        LEON
      </span>
      <p className="font-mono text-[13px] text-txt">unauthorized</p>
      <p className="font-mono text-[11.5px] text-dim">
        relaunch via <span className="border border-line-strong bg-raise px-1.5 py-0.5 text-txt">leon ui</span>{' '}
        to get a fresh token
      </p>
    </div>
  );
}

export function App() {
  const unauthorized = useUnauthorized();
  const board = useBoardState();
  // Below 1100px the rail/dock become overlay drawers; these are their states.
  const [railOpen, setRailOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);

  const { data, isError } = useQuery({
    queryKey: ['state'],
    queryFn: fetchState,
    enabled: !unauthorized,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    startEvents();
  }, []);

  useEffect(() => {
    if (data) seedFromRest(data);
  }, [data]);

  if (unauthorized) return <UnauthorizedScreen />;

  // Terminal modal follows the live session object so its status stays fresh.
  const openSession: Session | undefined =
    board.openSessionId == null
      ? undefined
      : board.sessions.find((session) => session.id === board.openSessionId);

  const needsYou = board.sessions.filter(
    (session) =>
      !session.archivedAt &&
      (session.status === 'waiting_permission' || session.status === 'waiting_input'),
  ).length;

  return (
    <div className="flex h-full flex-col">
      <Header
        connection={board.connection}
        sessions={board.sessions}
        approvals={board.approvals}
        view={board.view}
      />

      {board.view === 'sessions' ? (
        <Suspense fallback={null}>
          <SessionsView
            sessions={board.sessions}
            tasks={board.tasks}
            modalOpen={openSession != null}
          />
        </Suspense>
      ) : (
        /* relative so the rail/dock drawers can overlay on narrow screens */
        <div className="relative flex min-h-0 flex-1">
          {/* narrow-screen edge toggle — task rail drawer */}
          <button
            type="button"
            onClick={() => setRailOpen((value) => !value)}
            title={railOpen ? 'Close tasks' : 'Open tasks'}
            className="hidden w-7 shrink-0 flex-col items-center justify-center gap-2.5 border-r border-line bg-panel hover:bg-raise max-[1100px]:flex"
          >
            <span className="font-mono text-[10px] font-bold tracking-[0.3em] text-dim select-none [writing-mode:vertical-rl]">
              TASKS
            </span>
          </button>

          <TaskRail
            tasks={board.tasks}
            sessions={board.sessions}
            pullRequests={board.pullRequests}
            loaded={board.loaded}
            loadFailed={isError && board.connection !== 'connected'}
            mobileOpen={railOpen}
          />

          <ChatPanel />

          <AttentionDock
            sessions={board.sessions}
            pullRequests={board.pullRequests}
            mobileOpen={dockOpen}
          />

          {/* narrow-screen edge toggle — attention dock drawer */}
          <button
            type="button"
            onClick={() => setDockOpen((value) => !value)}
            title={dockOpen ? 'Close attention dock' : 'Open attention dock'}
            className="hidden w-7 shrink-0 flex-col items-center justify-center gap-2.5 border-l border-line bg-panel hover:bg-raise max-[1100px]:flex"
          >
            {needsYou > 0 && (
              <span className="attn-pulse border border-accent/60 bg-accent/10 px-1 py-px font-mono text-[10px] font-bold leading-none text-accent select-none">
                {needsYou}
              </span>
            )}
            <span className="font-mono text-[10px] font-bold tracking-[0.3em] text-dim select-none [writing-mode:vertical-rl]">
              NEEDS YOU
            </span>
          </button>
        </div>
      )}

      {openSession && (
        <Suspense fallback={null}>
          <TerminalModal session={openSession} onClose={() => setOpenSession(null)} />
        </Suspense>
      )}
    </div>
  );
}

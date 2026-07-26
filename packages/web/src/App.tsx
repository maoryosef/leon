import type { Session } from '@leon/shared';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Board } from './components/Board';
import { ChatPanel } from './components/ChatPanel';
import { Header } from './components/Header';
import { NewTaskForm } from './components/NewTaskForm';
import { PrRail } from './components/PrRail';

// xterm is heavy — split it out so the board loads lean.
const TerminalModal = lazy(() =>
  import('./components/TerminalModal').then((module) => ({ default: module.TerminalModal })),
);
import { fetchState, useUnauthorized } from './lib/api';
import { seedFromRest, startEvents, useBoardState } from './lib/ws-store';

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
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);

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
    openSessionId == null
      ? undefined
      : board.sessions.find((session) => session.id === openSessionId);

  return (
    <div className="flex h-full flex-col">
      <Header
        connection={board.connection}
        sessions={board.sessions}
        approvals={board.approvals}
        onNewTask={() => setNewTaskOpen(true)}
      />

      {/* relative so the chat panel can overlay from the right on narrow screens */}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {board.loaded && <PrRail pullRequests={board.pullRequests} />}

          {board.loaded ? (
            <Board
              tasks={board.tasks}
              sessions={board.sessions}
              pullRequests={board.pullRequests}
              onOpenSession={(session) => setOpenSessionId(session.id)}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <p className="font-mono text-[11.5px] text-faint">
                {isError && board.connection !== 'connected'
                  ? 'daemon unreachable — retrying…'
                  : 'loading state…'}
              </p>
            </div>
          )}
        </div>

        <ChatPanel />
      </div>

      {newTaskOpen && <NewTaskForm onClose={() => setNewTaskOpen(false)} />}
      {openSession && (
        <Suspense fallback={null}>
          <TerminalModal session={openSession} onClose={() => setOpenSessionId(null)} />
        </Suspense>
      )}
    </div>
  );
}

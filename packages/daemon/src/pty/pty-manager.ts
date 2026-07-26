import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';
import { VIEW_SESSION_PREFIX, type Session } from '@leon/shared';

const execFileP = promisify(execFile);
const MAX_PTYS = 20;

/** The daemon itself often runs inside tmux — never leak $TMUX into the
 * nested client or tmux will treat it as an unsafe nested session. */
function ptyEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

export interface TermHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  close(): void;
}

/**
 * One PTY per open terminal view. Each view gets its own *grouped* tmux
 * session (new-session -t <original>) so the viewer can focus the right
 * window without hijacking the user's real client, and destroy-unattached
 * cleans it up when the PTY dies. Read-only ("peek") is enforced here by
 * simply never writing client input to the PTY.
 */
export class PtyManager {
  private liveCount = 0;
  private counter = 0;
  private sweeper: NodeJS.Timeout;

  constructor() {
    // destroy-unattached is set asynchronously after the grouped session is
    // created; a client that detaches in that window leaves a zombie view
    // session behind. Reap unattached leon-view-* sessions periodically.
    this.sweeper = setInterval(() => void this.sweepZombies(), 60_000);
    this.sweeper.unref?.();
  }

  private async sweepZombies(): Promise<void> {
    try {
      const { stdout } = await execFileP('tmux', [
        'list-sessions',
        '-F',
        '#{session_name}\t#{session_attached}\t#{session_created}',
      ]);
      const now = Math.floor(Date.now() / 1000);
      for (const line of stdout.split('\n')) {
        const [name, attached, created] = line.split('\t');
        if (!name?.startsWith(VIEW_SESSION_PREFIX)) continue;
        if (attached !== '0') continue;
        if (now - Number(created) < 30) continue; // grace for just-created
        await execFileP('tmux', ['kill-session', '-t', `=${name}`]).catch(() => {});
      }
    } catch {
      // no tmux server — nothing to sweep
    }
  }

  async open(session: Session, cols: number, rows: number): Promise<TermHandle> {
    if (this.liveCount >= MAX_PTYS) {
      throw new Error(`too many open terminals (max ${MAX_PTYS})`);
    }
    // `new-session -t <missing>` would CREATE an unrelated empty session —
    // never let a stale session name do that. `=` forces exact matching.
    try {
      await execFileP('tmux', ['has-session', '-t', `=${session.tmuxSessionName}`]);
    } catch {
      throw new Error(`tmux session "${session.tmuxSessionName}" no longer exists`);
    }
    const viewName = `${VIEW_SESSION_PREFIX}${session.tmuxPaneId.replace('%', '')}-${this.counter++}`;
    const term = pty.spawn(
      'tmux',
      ['new-session', '-t', `=${session.tmuxSessionName}`, '-s', viewName],
      {
        name: 'xterm-256color',
        cols: Math.max(20, Math.min(cols, 500)),
        rows: Math.max(5, Math.min(rows, 200)),
        env: ptyEnv(),
      },
    );
    this.liveCount++;

    // best-effort: die on detach + focus the window/pane being viewed
    void (async () => {
      try {
        await execFileP('tmux', ['set-option', '-t', viewName, 'destroy-unattached', 'on']);
        await execFileP('tmux', [
          'select-window',
          '-t',
          `${viewName}:${session.tmuxWindowIndex}`,
        ]);
        await execFileP('tmux', ['select-pane', '-t', session.tmuxPaneId]);
      } catch {
        // grouped session may already be gone; harmless
      }
    })();

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.liveCount--;
      try {
        term.kill();
      } catch {
        /* already dead */
      }
      void execFileP('tmux', ['kill-session', '-t', viewName]).catch(() => {});
    };
    term.onExit(() => {
      if (!closed) {
        closed = true;
        this.liveCount--;
      }
    });

    return {
      write: (data) => term.write(data),
      resize: (c, r) => {
        try {
          term.resize(Math.max(20, Math.min(c, 500)), Math.max(5, Math.min(r, 200)));
        } catch {
          /* race with exit */
        }
      },
      onData: (cb) => term.onData(cb),
      onExit: (cb) => term.onExit(() => cb()),
      close,
    };
  }
}

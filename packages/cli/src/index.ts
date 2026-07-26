import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@leon/core';
import type { Session } from '@leon/shared';
import { installHooks } from './hooks-install.js';

const here = dirname(fileURLToPath(import.meta.url));

function usage(): never {
  console.log(`leon — sidekick for your Claude Code sessions

usage:
  leon daemon                 run the daemon in the foreground
  leon stop                   stop the running daemon
  leon ui                     open the web UI in your browser
  leon status                 list live sessions in the terminal
  leon attach <id|name|dir>   attach your terminal to a session's tmux
  leon install-hooks [--global]  instrument claude sessions to report status
`);
  process.exit(1);
}

async function fetchState(): Promise<{ sessions: Session[] }> {
  const config = loadConfig();
  const base = `http://${config.server.host}:${config.server.port}`;
  let res: Response;
  try {
    res = await fetch(`${base}/api/state`, {
      headers: { authorization: `Bearer ${config.server.token}` },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    console.error(`can't reach the Leon daemon at ${base} — is it running? Start it with: pnpm start`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`daemon responded ${res.status} — token mismatch? Check ${config.configPath}`);
    process.exit(1);
  }
  return (await res.json()) as { sessions: Session[] };
}

function findSession(sessions: Session[], query: string): Session | null {
  const live = sessions.filter((s) => s.status !== 'dead');
  return (
    live.find((s) => s.id === query) ??
    // short ids shown by `leon status` are the ULID *suffix* (the prefix is
    // a timestamp shared by sessions discovered in the same tick)
    live.find((s) => s.id.toLowerCase().endsWith(query.toLowerCase())) ??
    live.find((s) => s.tmuxSessionName === query) ??
    live.find((s) => s.cwd.split('/').pop() === query) ??
    live.find((s) => (s.title ?? '').toLowerCase().includes(query.toLowerCase())) ??
    null
  );
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'daemon': {
    const entry = join(here, '..', '..', 'daemon', 'src', 'index.ts');
    const require = (await import('node:module')).createRequire(import.meta.url);
    const tsx = require.resolve('tsx/cli');
    const child = spawn(process.execPath, [tsx, entry], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 1));
    break;
  }

  case 'stop': {
    const config = loadConfig();
    const port = String(config.server.port);
    const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    const pids = (out.stdout ?? '').trim().split('\n').filter(Boolean).map(Number);
    if (pids.length === 0) {
      console.log(`no daemon listening on port ${port}`);
      break;
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    // give it a moment, then verify
    await new Promise((r) => setTimeout(r, 1500));
    const still = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if ((still.stdout ?? '').trim()) {
      console.error(`daemon (pid ${pids.join(',')}) did not exit — force with: kill -9 ${pids.join(' ')}`);
      process.exit(1);
    }
    console.log(`daemon stopped (pid ${pids.join(', ')})`);
    break;
  }

  case 'ui': {
    const config = loadConfig();
    const url = `http://${config.server.host}:${config.server.port}/?token=${config.server.token}`;
    try {
      execFileSync('open', [url]);
      console.log(`opened ${url.replace(config.server.token, '<token>')}`);
    } catch {
      console.log(url);
    }
    break;
  }

  case 'status': {
    const { sessions } = await fetchState();
    if (sessions.length === 0) {
      console.log('no claude sessions found');
      break;
    }
    const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
    console.log(
      `${pad('STATUS', 20)} ${pad('DIR', 36)} ${pad('TMUX', 26)} ${pad('ACTIVITY', 20)} ID`,
    );
    for (const s of sessions) {
      const statusLabel = s.status + (s.statusSource === 'scrape' || s.statusSource === 'tmux' ? '?' : '');
      console.log(
        `${pad(statusLabel, 20)} ${pad(s.cwd.split('/').pop() ?? s.cwd, 36)} ${pad(
          `${s.tmuxSessionName}:${s.tmuxWindowIndex}`,
          26,
        )} ${pad(s.currentActivity ?? '-', 20)} ${s.id.slice(-8).toLowerCase()}`,
      );
    }
    break;
  }

  case 'attach': {
    const query = rest[0];
    if (!query) usage();
    const { sessions } = await fetchState();
    const session = findSession(sessions, query);
    if (!session) {
      console.error(`no live session matches "${query}" — try \`leon status\``);
      process.exit(1);
    }

    const tmuxRun = (args: string[]) => spawnSync('tmux', args, { encoding: 'utf8' });

    // the DB session name can go stale (renames, server restarts) — verify first
    if (tmuxRun(['has-session', '-t', `=${session.tmuxSessionName}`]).status !== 0) {
      console.error(
        `tmux session "${session.tmuxSessionName}" no longer exists — the daemon will mark it dead shortly. Try \`leon status\` again.`,
      );
      process.exit(1);
    }

    // Focus the exact claude pane BEFORE the client arrives: the session's
    // active window/pane is often something else (a zsh split, another
    // window), which would look like attaching to an empty shell.
    tmuxRun(['select-window', '-t', session.tmuxPaneId]);
    tmuxRun(['select-pane', '-t', session.tmuxPaneId]);

    console.log(
      `→ ${session.title ?? session.cwd.split('/').pop()} — tmux ${session.tmuxSessionName}, pane ${session.tmuxPaneId} [${session.status}]`,
    );
    const res = process.env.TMUX
      ? // already inside tmux — switch this client, no nesting
        spawnSync('tmux', ['switch-client', '-t', `=${session.tmuxSessionName}`], {
          stdio: 'inherit',
        })
      : spawnSync('tmux', ['attach-session', '-t', `=${session.tmuxSessionName}`], {
          stdio: 'inherit',
        });
    if (res.status !== 0) {
      console.error(
        `tmux ${process.env.TMUX ? 'switch-client' : 'attach-session'} failed (exit ${res.status}). ` +
          `Manual fallback: tmux ${process.env.TMUX ? 'switch-client' : 'attach'} -t '${session.tmuxSessionName}'`,
      );
      process.exit(res.status ?? 1);
    }
    break;
  }

  case 'install-hooks': {
    installHooks({ global: rest.includes('--global') });
    break;
  }

  default:
    usage();
}

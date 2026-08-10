import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, type DesktopConfig } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A GUI app inherits a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin) when it is
 * launched from Finder or the Dock. The daemon shells out to tmux, gh and
 * claude, so it needs the PATH the user actually has — ask their login shell
 * for it once and cache the answer.
 */
let cachedPath: string | undefined;
function loginPath(): string {
  if (cachedPath !== undefined) return cachedPath;
  const inherited = process.env.PATH ?? '';
  try {
    const shell = process.env.SHELL ?? '/bin/zsh';
    const out = execFileSync(shell, ['-lic', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    cachedPath = out.length > 0 ? Array.from(new Set([...out.split(':'), ...inherited.split(':')])).join(':') : inherited;
  } catch {
    cachedPath = inherited;
  }
  return cachedPath;
}

/**
 * The daemon must run under the *system* Node, not Electron's — better-sqlite3
 * and node-pty are compiled for the system ABI. process.execPath here is the
 * Electron binary, so find a real node.
 */
export function resolveNode(): string | null {
  const candidates = [
    process.env.LEON_NODE,
    // fnm keeps a stable symlink for the default version
    join(homedir(), '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node'),
    join(homedir(), '.fnm', 'aliases', 'default', 'bin', 'node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter((path): path is string => typeof path === 'string' && path.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // last resort: whatever the login shell resolves
  try {
    const shell = process.env.SHELL ?? '/bin/zsh';
    const found = execFileSync(shell, ['-lic', 'command -v node'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return found && existsSync(found) ? found : null;
  } catch {
    return null;
  }
}

/** Repo path stamped into package.json at package time (see the dist script). */
function bakedRepo(): string | null {
  try {
    const meta = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      leonRepo?: string;
    };
    return meta.leonRepo ?? null;
  } catch {
    return null;
  }
}

/**
 * The repo this desktop shell drives. In dev that's three levels up from
 * dist/; a packaged build uses the path baked in at build time, or LEON_REPO.
 */
export function resolveRepo(): string | null {
  const candidates = [
    process.env.LEON_REPO,
    join(here, '..', '..', '..'), // packages/desktop/dist → repo root
    bakedRepo(), // written into package.json by `pnpm dist`
  ].filter((path): path is string => typeof path === 'string' && path.length > 0);

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'packages', 'daemon', 'src', 'index.ts'))) return candidate;
  }
  return null;
}

/** true when a Leon that accepts our token owns the port. */
export async function isHealthy(config: DesktopConfig): Promise<boolean> {
  try {
    const res = await fetch(`${config.baseUrl}/api/state`, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface DaemonHandle {
  config: DesktopConfig;
  /** null when we attached to a daemon someone else started (tmux, CLI) */
  child: ChildProcess | null;
  log: string[];
}

export class DaemonError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

/**
 * Attach to a running Leon, or start one. Attaching matters: the daemon is
 * often already up in tmux, and starting a second one would just collide on
 * the port.
 */
export async function ensureDaemon(onLog: (line: string) => void): Promise<DaemonHandle> {
  const existing = readConfig();
  if (existing && (await isHealthy(existing))) {
    onLog(`attached to the daemon already running at ${existing.baseUrl}`);
    return { config: existing, child: null, log: [] };
  }

  const repo = resolveRepo();
  if (!repo) {
    throw new DaemonError(
      'Leon repo not found',
      'The desktop app runs the daemon from the repo checkout. Set LEON_REPO to the repo path and reopen.',
    );
  }
  const node = resolveNode();
  if (!node) {
    throw new DaemonError(
      'Node.js not found',
      'The daemon needs Node ≥ 22 (its native modules are built for it). Set LEON_NODE to your node binary and reopen.',
    );
  }

  const entry = join(repo, 'packages', 'daemon', 'src', 'index.ts');
  let tsx: string;
  try {
    tsx = createRequire(join(repo, 'packages', 'daemon', 'package.json')).resolve('tsx/cli');
  } catch {
    const binary = join(repo, 'node_modules', '.bin', 'tsx');
    if (!existsSync(binary)) {
      throw new DaemonError('tsx not found', `Run pnpm install in ${repo}, then reopen Leon.`);
    }
    tsx = binary;
  }

  onLog(`starting the daemon — ${node} ${entry}`);
  const log: string[] = [];
  const child = spawn(node, [tsx, entry], {
    cwd: repo,
    env: { ...process.env, PATH: loginPath() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer) => {
    const text = chunk.toString();
    log.push(text);
    if (log.length > 200) log.shift();
    onLog(text.trimEnd());
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let exited: number | null = null;
  child.on('exit', (code) => {
    exited = code ?? 0;
  });

  // the very first run writes ~/.leon/config.toml, so the config may not
  // exist until the daemon has booted
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new DaemonError(
        `The daemon exited (code ${exited})`,
        log.join('').slice(-1500) || 'No output was captured.',
      );
    }
    const config = readConfig();
    if (config && (await isHealthy(config))) {
      onLog(`daemon is up at ${config.baseUrl}`);
      return { config, child, log };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  child.kill('SIGTERM');
  throw new DaemonError(
    'The daemon did not come up in 30s',
    log.join('').slice(-1500) || 'No output was captured.',
  );
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
}

/** One `ps` snapshot for the whole tick — cheap and race-free enough. */
export async function processSnapshot(): Promise<ProcInfo[]> {
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,comm='], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const procs: ProcInfo[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]!.trim() });
  }
  return procs;
}

/**
 * Finds a `claude` process that is a descendant of `rootPid` (the pane's
 * shell). Verified on this machine: claude is normally a direct child of the
 * pane shell, but we walk the whole subtree to survive wrappers.
 */
export function findClaudeDescendant(rootPid: number, procs: ProcInfo[]): ProcInfo | null {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    const list = byParent.get(p.ppid);
    if (list) list.push(p);
    else byParent.set(p.ppid, [p]);
  }
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      if (isClaudeCommand(child.command)) return child;
      queue.push(child.pid);
    }
  }
  return null;
}

export function isClaudeCommand(command: string): boolean {
  // comm= gives the executable name/path, e.g. "claude" or "/opt/homebrew/bin/claude"
  const base = command.split('/').pop() ?? command;
  return base === 'claude';
}

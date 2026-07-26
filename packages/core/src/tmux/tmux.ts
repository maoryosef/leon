import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface TmuxPane {
  paneId: string; // "%42"
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  panePid: number;
  currentPath: string;
  currentCommand: string;
}

const PANE_FORMAT =
  '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}';

export class Tmux {
  constructor(private bin = 'tmux') {}

  private async run(args: string[]): Promise<string> {
    const { stdout } = await execFileP(this.bin, args, { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  }

  /** All panes across all sessions; [] when no tmux server is running. */
  async listPanes(): Promise<TmuxPane[]> {
    let out: string;
    try {
      out = await this.run(['list-panes', '-a', '-F', PANE_FORMAT]);
    } catch {
      return []; // no server running
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => parsePaneLine(line))
      .filter((p): p is TmuxPane => p !== null);
  }

  /** Visible contents of a pane (with trailing empty lines trimmed by tmux -J off). */
  async capturePane(paneId: string, lines = 0): Promise<string> {
    const args = ['capture-pane', '-p', '-t', paneId];
    if (lines > 0) args.push('-S', `-${lines}`);
    return this.run(args);
  }

  /** Send literal text to a pane. `enter` appends a carriage return. */
  async sendKeys(paneId: string, text: string, enter: boolean): Promise<void> {
    // -l = literal (no key-name lookup), so text like "y" or a prompt is safe
    await this.run(['send-keys', '-t', paneId, '-l', text]);
    if (enter) await this.run(['send-keys', '-t', paneId, 'Enter']);
  }

  async newSession(name: string, cwd: string): Promise<string> {
    // -P -F prints the new pane id so the caller can register it immediately
    const out = await this.run([
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      cwd,
      '-P',
      '-F',
      '#{pane_id}',
    ]);
    return out.trim();
  }

  async killPane(paneId: string): Promise<void> {
    await this.run(['kill-pane', '-t', paneId]);
  }

  async hasServer(): Promise<boolean> {
    try {
      await this.run(['list-sessions']);
      return true;
    } catch {
      return false;
    }
  }
}

export function parsePaneLine(line: string): TmuxPane | null {
  const parts = line.split('\t');
  if (parts.length < 7) return null;
  const [paneId, sessionName, windowIndex, paneIndex, panePid, currentPath, currentCommand] =
    parts as [string, string, string, string, string, string, string];
  const wi = Number(windowIndex);
  const pi = Number(paneIndex);
  const pid = Number(panePid);
  if (!paneId.startsWith('%') || Number.isNaN(wi) || Number.isNaN(pid)) return null;
  return {
    paneId,
    sessionName,
    windowIndex: wi,
    paneIndex: pi,
    panePid: pid,
    currentPath,
    currentCommand,
  };
}

import { closeSync, openSync, readSync, statSync, watch, type FSWatcher } from 'node:fs';
import type { StatusSignal } from './status-engine.js';

export interface TranscriptEvent {
  signal: Omit<StatusSignal, 'sessionId' | 'source'>;
}

/**
 * Incrementally tails a Claude Code transcript (.jsonl). The format is
 * undocumented — the parser is deliberately defensive: unknown lines are
 * ignored, a malformed line never crashes the tailer.
 */
export class TranscriptTailer {
  private offset = 0;
  private remainder = '';
  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reading = false;

  constructor(
    private readonly path: string,
    private readonly onEvent: (event: TranscriptEvent) => void,
  ) {}

  start(): void {
    try {
      this.offset = statSync(this.path).size; // only new activity matters
    } catch {
      this.offset = 0;
    }
    try {
      this.watcher = watch(this.path, () => this.readNew());
    } catch {
      // file may vanish; polling below still covers it
    }
    // poll fallback — fs.watch on macOS occasionally drops events
    this.pollTimer = setInterval(() => this.readNew(), 3000);
    this.pollTimer.unref?.();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private readNew(): void {
    if (this.reading) return;
    this.reading = true;
    try {
      const size = statSync(this.path).size;
      if (size < this.offset) this.offset = 0; // truncated/rotated
      if (size === this.offset) return;
      const fd = openSync(this.path, 'r');
      try {
        const len = size - this.offset;
        const buf = Buffer.alloc(Math.min(len, 4 * 1024 * 1024));
        const read = readSync(fd, buf, 0, buf.length, this.offset);
        this.offset += read;
        const chunk = this.remainder + buf.toString('utf8', 0, read);
        const lines = chunk.split('\n');
        this.remainder = lines.pop() ?? '';
        this.processLines(lines);
      } finally {
        closeSync(fd);
      }
    } catch {
      // file gone or unreadable — discovery will mark the session dead
    } finally {
      this.reading = false;
    }
  }

  private processLines(lines: string[]): void {
    let latest: TranscriptEvent | null = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const event = interpretTranscriptLine(obj);
      if (event) latest = event;
    }
    if (latest) this.onEvent(latest);
  }
}

/**
 * Maps one transcript record to a status event. Transcript growth means the
 * agent is doing something ⇒ 'working'; a tool_use block also names the
 * current activity. Turn *ends* are detected by hooks (Stop), not here —
 * the transcript signal simply goes stale (60s trust window) and lower
 * tiers take over.
 */
export function interpretTranscriptLine(obj: unknown): TranscriptEvent | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (rec.type !== 'assistant' && rec.type !== 'user') return null;

  let activity: string | null = null;
  const message = rec.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as Record<string, unknown>).type === 'tool_use' &&
        typeof (block as Record<string, unknown>).name === 'string'
      ) {
        activity = (block as Record<string, unknown>).name as string;
      }
    }
  }

  return {
    signal: { status: 'working', at: new Date().toISOString(), activity },
  };
}

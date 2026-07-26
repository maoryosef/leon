import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude Code stores transcripts under ~/.claude/projects/<encoded-cwd>/,
 * where the cwd is encoded by replacing both `/` and `.` with `-`.
 * (Verified against live dirs, e.g. /Users/x/.superset/… → -Users-x--superset-….)
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export function projectsRoot(): string {
  return process.env.LEON_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
}

/** Compact view of the last N transcript records — for Leon's
 * get_session_transcript_tail tool. Defensive: unknown lines are skipped. */
export function readTranscriptTail(
  path: string,
  entries: number,
): { role: string; text?: string; tool?: string }[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean).slice(-Math.max(entries * 3, 30));
  const out: { role: string; text?: string; tool?: string }[] = [];
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== 'assistant' && obj.type !== 'user') continue;
    const message = obj.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (typeof content === 'string') {
      out.push({ role: obj.type, text: content.slice(0, 400) });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        out.push({ role: obj.type as string, text: (b.text as string).slice(0, 400) });
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        out.push({ role: obj.type as string, tool: b.name as string });
      }
    }
  }
  return out.slice(-entries);
}

export interface TranscriptCandidate {
  path: string;
  claudeSessionId: string;
  mtimeMs: number;
}

/**
 * Transcript files for a cwd, newest first. `activeSinceMs` filters out
 * long-dead transcripts (e.g. only files touched in the last few minutes).
 */
export function findTranscripts(cwd: string, activeSinceMs?: number): TranscriptCandidate[] {
  const dir = join(projectsRoot(), encodeProjectDir(cwd));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: TranscriptCandidate[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (activeSinceMs !== undefined && Date.now() - mtimeMs > activeSinceMs) continue;
    out.push({ path, claudeSessionId: name.replace(/\.jsonl$/, ''), mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

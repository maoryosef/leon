import { readdirSync, statSync } from 'node:fs';
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

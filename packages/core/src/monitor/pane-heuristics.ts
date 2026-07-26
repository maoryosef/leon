import type { SessionStatus } from '@leon/shared';

/**
 * Scrape-tier status detection from `tmux capture-pane` output.
 *
 * ⚠ These patterns are coupled to Claude Code's TUI (verified against
 * Claude Code ~2026-07) and WILL rot when its UI changes. They are the
 * lowest-trust signal tier — hooks and transcripts win whenever present.
 * Keep every pattern in this table, nowhere else.
 */
const PATTERNS: { status: SessionStatus; test: (tail: string) => boolean }[] = [
  {
    // Permission prompt: question + numbered options with a selector.
    //   "Do you want to proceed?"  /  "❯ 1. Yes"  /  "Esc to cancel"
    status: 'waiting_permission',
    test: (t) =>
      /(Do you want|Would you like|Allow this|Grant access)[^\n]*\??/i.test(t) &&
      /❯?\s*1\.\s/.test(t),
  },
  {
    // Agent mid-turn: spinner verb line with "esc to interrupt", or a
    // spinner glyph on the last few lines.
    status: 'working',
    test: (t) => /esc to interrupt/i.test(t) || /[✻✽✶✳✢·]\s+\S+…/.test(t),
  },
  {
    // Idle input prompt between horizontal rules: "❯ " with no spinner.
    status: 'idle_done',
    test: (t) => /^❯\s*$/m.test(t) || /^\s*❯\s*$/m.test(t),
  },
];

export function statusFromPaneContent(content: string): SessionStatus | null {
  // Only the visible tail matters; prompts always render at the bottom.
  const tail = content.split('\n').slice(-25).join('\n');
  for (const p of PATTERNS) {
    if (p.test(tail)) return p.status;
  }
  return null;
}

import { z } from 'zod';

/**
 * Derived state of a Claude Code session running in a tmux pane.
 */
export const SessionStatus = z.enum([
  'working', // agent mid-turn (tool calls / streaming)
  'waiting_input', // agent asked a question / idle awaiting user text
  'waiting_permission', // Claude Code permission prompt on screen
  'idle_done', // turn finished, nothing pending
  'dead', // pane gone or claude process exited
  'unknown', // discovered, no signal yet
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/**
 * Which signal source produced the current status. Higher-trust sources
 * (hook > transcript > scrape > tmux) win while fresh; the UI renders
 * lower-trust statuses with a "low confidence" hint.
 */
export const StatusSource = z.enum(['hook', 'transcript', 'scrape', 'tmux']);
export type StatusSource = z.infer<typeof StatusSource>;

/** Freshness window per source, in ms. A fresh higher-trust signal always wins. */
export const STATUS_TRUST_WINDOW_MS: Record<StatusSource, number> = {
  hook: 10 * 60_000,
  transcript: 60_000,
  scrape: 10_000,
  tmux: 10 * 60_000, // liveness only (dead / alive)
};

export const STATUS_SOURCE_PRECEDENCE: Record<StatusSource, number> = {
  hook: 3,
  transcript: 2,
  scrape: 1,
  tmux: 0,
};

import type { SessionStatus, StatusSource } from '@leon/shared';
import { STATUS_SOURCE_PRECEDENCE, STATUS_TRUST_WINDOW_MS } from '@leon/shared';

export interface StatusSignal {
  sessionId: string;
  status: SessionStatus;
  source: StatusSource;
  at: string; // ISO timestamp
  activity?: string | null;
}

export type ApplyStatus = (
  sessionId: string,
  status: SessionStatus,
  source: StatusSource,
  activity: string | null | undefined,
  at: string,
) => void;

/**
 * Merges status signals from the three tiers (hook > transcript > scrape,
 * plus tmux liveness). Rule: among signals still inside their source's
 * trust window, the highest-precedence source wins; with no fresh signal,
 * the most recent one wins.
 */
export class StatusEngine {
  private signals = new Map<string, Map<StatusSource, StatusSignal>>();

  constructor(private apply: ApplyStatus) {}

  ingest(signal: StatusSignal): void {
    // A tmux-level "dead" is definitive: pane or claude process is gone.
    if (signal.status === 'dead') {
      this.signals.delete(signal.sessionId);
      this.apply(signal.sessionId, 'dead', signal.source, null, signal.at);
      return;
    }
    let perSource = this.signals.get(signal.sessionId);
    if (!perSource) {
      perSource = new Map();
      this.signals.set(signal.sessionId, perSource);
    }
    perSource.set(signal.source, signal);

    const winner = this.winner(perSource);
    if (winner) {
      this.apply(winner.sessionId, winner.status, winner.source, winner.activity, winner.at);
    }
  }

  /** True when neither a fresh hook nor a fresh transcript signal exists — scrape needed. */
  needsScrape(sessionId: string): boolean {
    const perSource = this.signals.get(sessionId);
    if (!perSource) return true;
    for (const source of ['hook', 'transcript'] as const) {
      const s = perSource.get(source);
      if (s && this.isFresh(s)) return false;
    }
    return true;
  }

  forget(sessionId: string): void {
    this.signals.delete(sessionId);
  }

  private isFresh(s: StatusSignal): boolean {
    return Date.now() - Date.parse(s.at) <= STATUS_TRUST_WINDOW_MS[s.source];
  }

  private winner(perSource: Map<StatusSource, StatusSignal>): StatusSignal | null {
    const all = [...perSource.values()];
    const fresh = all.filter((s) => this.isFresh(s));
    const pool = fresh.length > 0 ? fresh : all;
    if (pool.length === 0) return null;
    return pool.sort(
      (a, b) =>
        STATUS_SOURCE_PRECEDENCE[b.source] - STATUS_SOURCE_PRECEDENCE[a.source] ||
        Date.parse(b.at) - Date.parse(a.at),
    )[0]!;
  }
}

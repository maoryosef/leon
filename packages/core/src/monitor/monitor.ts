import { VIEW_SESSION_PREFIX, type HookPayload, type Session } from '@leon/shared';
import type { EventBus } from '../events.js';
import { findClaudeDescendant, processSnapshot } from '../tmux/processes.js';
import type { Tmux, TmuxPane } from '../tmux/tmux.js';
import type { SessionService } from '../services/session-service.js';
import { statusFromHook } from './hook-signals.js';
import { statusFromPaneContent } from './pane-heuristics.js';
import { StatusEngine } from './status-engine.js';
import { TranscriptTailer } from './transcript-tailer.js';
import { findTranscripts } from './transcripts.js';
import { nowIso } from '../util/time.js';

const ARCHIVE_AFTER_DEAD_MS = 5 * 60_000;
const TRANSCRIPT_ACTIVE_WINDOW_MS = 10 * 60_000;

export interface MonitorOptions {
  pollMs: number;
  scrapeMs: number;
}

/**
 * Orchestrates the three signal tiers: tmux discovery/liveness (poll),
 * transcript tailers, pane scraping, and hook ingestion from the daemon.
 */
export class Monitor {
  readonly engine: StatusEngine;
  private tailers = new Map<string, TranscriptTailer>(); // by session id
  private deadSince = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | null = null;
  private scrapeTimer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private tmux: Tmux,
    private sessions: SessionService,
    private bus: EventBus,
    private opts: MonitorOptions,
  ) {
    this.engine = new StatusEngine((id, status, source, activity, at) =>
      this.sessions.applyStatus(id, status, source, activity, at),
    );
  }

  async start(): Promise<void> {
    await this.tick();
    this.pollTimer = setInterval(() => void this.tick(), this.opts.pollMs);
    this.scrapeTimer = setInterval(() => void this.scrapeTick(), this.opts.scrapeMs);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.scrapeTimer) clearInterval(this.scrapeTimer);
    for (const t of this.tailers.values()) t.stop();
    this.tailers.clear();
  }

  /** Discovery + liveness pass. */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const [allPanes, procs] = await Promise.all([this.tmux.listPanes(), processSnapshot()]);
      // Grouped view sessions (web peek/attach) share windows with the real
      // session, so their panes are duplicates — seeing them here would
      // corrupt tmuxSessionName. Also dedupe by pane id defensively.
      const seenPaneIds = new Set<string>();
      const panes = allPanes.filter((p) => {
        if (p.sessionName.startsWith(VIEW_SESSION_PREFIX)) return false;
        if (seenPaneIds.has(p.paneId)) return false;
        seenPaneIds.add(p.paneId);
        return true;
      });
      const claudePanes = panes.filter(
        (p) => p.currentCommand === 'claude' || findClaudeDescendant(p.panePid, procs) !== null,
      );
      const active = this.sessions.listActive();
      const byPaneId = new Map(active.map((s) => [s.tmuxPaneId, s]));
      const seen = new Set<string>();

      for (const pane of claudePanes) {
        seen.add(pane.paneId);
        const existing = byPaneId.get(pane.paneId);
        if (existing) {
          this.sessions.updatePaneInfo(existing.id, pane);
          if (existing.status === 'dead') this.deadSince.delete(existing.id);
          this.ensureTranscript(existing);
        } else {
          const session = this.sessions.createFromPane(pane, 'discovered');
          this.ensureTranscript(session);
        }
      }

      // liveness: sessions whose claude pane is gone
      const now = Date.now();
      for (const session of active) {
        if (seen.has(session.tmuxPaneId)) continue;
        if (session.status !== 'dead') {
          this.engine.ingest({
            sessionId: session.id,
            status: 'dead',
            source: 'tmux',
            at: nowIso(),
          });
          this.stopTailer(session.id);
          this.deadSince.set(session.id, now);
        } else {
          const since = this.deadSince.get(session.id) ?? now;
          this.deadSince.set(session.id, since);
          if (now - since > ARCHIVE_AFTER_DEAD_MS) {
            this.sessions.archive(session.id);
            this.engine.forget(session.id);
            this.deadSince.delete(session.id);
          }
        }
      }
    } catch (err) {
      // never let a bad tick kill the loop
      console.error('[monitor] tick failed:', err);
    } finally {
      this.ticking = false;
    }
  }

  /** Scrape pass for sessions with no fresh hook/transcript signal. */
  private async scrapeTick(): Promise<void> {
    const active = this.sessions.listActive();
    for (const session of active) {
      if (session.status === 'dead') continue;
      if (!this.engine.needsScrape(session.id)) continue;
      try {
        const content = await this.tmux.capturePane(session.tmuxPaneId);
        const status = statusFromPaneContent(content);
        if (status) {
          this.engine.ingest({
            sessionId: session.id,
            status,
            source: 'scrape',
            at: nowIso(),
          });
        }
      } catch {
        // pane may have just died; the next tick handles it
      }
    }
  }

  /** Called by the daemon's /hooks receiver. Returns the matched session, if any. */
  ingestHook(payload: HookPayload): Session | null {
    const session = this.correlateHook(payload);
    if (!session) return null;

    // bind claude identity on first contact
    if (!session.claudeSessionId || session.claudeSessionId !== payload.session_id) {
      this.sessions.adopt(session.id, {
        claudeSessionId: payload.session_id,
        transcriptPath: payload.transcript_path,
        instrumented: true,
      });
      this.restartTailer(session.id, payload.transcript_path);
    } else if (!session.instrumented) {
      this.sessions.adopt(session.id, { instrumented: true });
    }

    const mapped = statusFromHook(payload);
    if (mapped) {
      this.engine.ingest({
        sessionId: session.id,
        status: mapped.status,
        source: 'hook',
        at: nowIso(),
        activity: mapped.activity,
      });
    }
    return this.sessions.get(session.id);
  }

  private correlateHook(payload: HookPayload): Session | null {
    if (payload.leon_session_id) {
      const s = this.sessions.get(payload.leon_session_id);
      if (s && !s.archivedAt) return s;
    }
    const byClaude = this.sessions.getByClaudeSessionId(payload.session_id);
    if (byClaude) return byClaude;
    if (payload.cwd) {
      const candidates = this.sessions.findUnclaimedByCwd(payload.cwd);
      if (candidates.length > 0) return candidates[0]!;
    }
    return null;
  }

  /** Correlate a transcript for sessions discovered without hooks. */
  private ensureTranscript(session: Session): void {
    if (this.tailers.has(session.id)) return;
    if (session.transcriptPath) {
      this.startTailer(session.id, session.transcriptPath);
      return;
    }
    const claimed = this.sessions.claimedTranscriptPaths();
    const candidates = findTranscripts(session.cwd, TRANSCRIPT_ACTIVE_WINDOW_MS).filter(
      (c) => !claimed.has(c.path),
    );
    const best = candidates[0];
    if (!best) return;
    this.sessions.adopt(session.id, {
      claudeSessionId: best.claudeSessionId,
      transcriptPath: best.path,
    });
    this.startTailer(session.id, best.path);
  }

  private startTailer(sessionId: string, path: string): void {
    const tailer = new TranscriptTailer(path, (event) => {
      this.engine.ingest({
        sessionId,
        source: 'transcript',
        status: event.signal.status,
        at: event.signal.at,
        activity: event.signal.activity,
      });
    });
    tailer.start();
    this.tailers.set(sessionId, tailer);
  }

  private restartTailer(sessionId: string, path: string | undefined): void {
    this.stopTailer(sessionId);
    if (path) this.startTailer(sessionId, path);
  }

  private stopTailer(sessionId: string): void {
    const tailer = this.tailers.get(sessionId);
    if (tailer) {
      tailer.stop();
      this.tailers.delete(sessionId);
    }
  }
}

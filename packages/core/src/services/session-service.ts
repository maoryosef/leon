import { ulid } from 'ulid';
import type { Session, SessionOrigin, SessionStatus, StatusSource } from '@leon/shared';
import type { LeonDb } from '../db/index.js';
import { sessionFromRow, type SessionRow } from '../db/rows.js';
import type { EventBus } from '../events.js';
import type { TmuxPane } from '../tmux/tmux.js';
import { nowIso } from '../util/time.js';

export class SessionService {
  constructor(
    private db: LeonDb,
    private bus: EventBus,
  ) {}

  listActive(): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY created_at')
      .all() as SessionRow[];
    return rows.map(sessionFromRow);
  }

  get(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    return row ? sessionFromRow(row) : null;
  }

  getByPaneId(paneId: string): Session | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE tmux_pane_id = ? AND archived_at IS NULL')
      .get(paneId) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  getByClaudeSessionId(claudeSessionId: string): Session | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE claude_session_id = ? AND archived_at IS NULL')
      .get(claudeSessionId) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  /** Active sessions in a cwd with no claude identity yet — hook correlation candidates. */
  findUnclaimedByCwd(cwd: string): Session[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE cwd = ? AND archived_at IS NULL AND claude_session_id IS NULL
         ORDER BY created_at DESC`,
      )
      .all(cwd) as SessionRow[];
    return rows.map(sessionFromRow);
  }

  claimedTranscriptPaths(): Set<string> {
    const rows = this.db
      .prepare(
        'SELECT transcript_path FROM sessions WHERE transcript_path IS NOT NULL AND archived_at IS NULL',
      )
      .all() as { transcript_path: string }[];
    return new Set(rows.map((r) => r.transcript_path));
  }

  createFromPane(pane: TmuxPane, origin: SessionOrigin): Session {
    const now = nowIso();
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, task_id, tmux_session_name, tmux_window_index, tmux_pane_id, pane_pid, cwd,
          claude_session_id, transcript_path, instrumented, origin,
          status, status_since, status_source, current_activity, last_activity_at,
          title, archived_at, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, 'unknown', ?, 'tmux', NULL, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, pane.sessionName, pane.windowIndex, pane.paneId, pane.panePid, pane.currentPath, origin, now, now, now, now);
    const session = this.get(id)!;
    this.bus.emit({ type: 'session.upserted', session });
    return session;
  }

  applyStatus(
    id: string,
    status: SessionStatus,
    source: StatusSource,
    activity: string | null | undefined,
    at: string,
  ): void {
    const current = this.get(id);
    if (!current || current.archivedAt) return;
    const activityChanged = activity !== undefined && activity !== current.currentActivity;
    const statusChanged = current.status !== status || current.statusSource !== source;
    if (!statusChanged && !activityChanged) {
      // still bump lastActivityAt quietly for liveness ordering
      this.db
        .prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?')
        .run(at, id);
      return;
    }
    const statusSince = current.status !== status ? at : current.statusSince;
    this.db
      .prepare(
        `UPDATE sessions SET status = ?, status_since = ?, status_source = ?,
         current_activity = ?, last_activity_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        status,
        statusSince,
        source,
        activity === undefined ? current.currentActivity : activity,
        at,
        at,
        id,
      );
    if (current.status !== status) {
      this.db
        .prepare('INSERT INTO status_history (session_id, status, source, at) VALUES (?, ?, ?, ?)')
        .run(id, status, source, at);
    }
    const session = this.get(id)!;
    this.bus.emit({ type: 'session.status', sessionId: id, session });
  }

  /** Bind Claude Code identity (from a hook or transcript correlation). */
  adopt(
    id: string,
    fields: { claudeSessionId?: string; transcriptPath?: string; instrumented?: boolean },
  ): Session | null {
    const current = this.get(id);
    if (!current) return null;
    this.db
      .prepare(
        `UPDATE sessions SET
           claude_session_id = COALESCE(?, claude_session_id),
           transcript_path = COALESCE(?, transcript_path),
           instrumented = COALESCE(?, instrumented),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        fields.claudeSessionId ?? null,
        fields.transcriptPath ?? null,
        fields.instrumented === undefined ? null : fields.instrumented ? 1 : 0,
        nowIso(),
        id,
      );
    const session = this.get(id)!;
    this.bus.emit({ type: 'session.upserted', session });
    return session;
  }

  updatePaneInfo(id: string, pane: TmuxPane): void {
    const current = this.get(id);
    if (!current) return;
    if (
      current.cwd === pane.currentPath &&
      current.tmuxSessionName === pane.sessionName &&
      current.tmuxWindowIndex === pane.windowIndex
    ) {
      return;
    }
    this.db
      .prepare(
        'UPDATE sessions SET cwd = ?, tmux_session_name = ?, tmux_window_index = ?, updated_at = ? WHERE id = ?',
      )
      .run(pane.currentPath, pane.sessionName, pane.windowIndex, nowIso(), id);
    this.bus.emit({ type: 'session.upserted', session: this.get(id)! });
  }

  link(id: string, taskId: string | null): Session | null {
    const current = this.get(id);
    if (!current) return null;
    this.db
      .prepare('UPDATE sessions SET task_id = ?, updated_at = ? WHERE id = ?')
      .run(taskId, nowIso(), id);
    const session = this.get(id)!;
    this.bus.emit({ type: 'session.upserted', session });
    return session;
  }

  setTitle(id: string, title: string | null): Session | null {
    const current = this.get(id);
    if (!current) return null;
    this.db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, nowIso(), id);
    const session = this.get(id)!;
    this.bus.emit({ type: 'session.upserted', session });
    return session;
  }

  archive(id: string): void {
    const now = nowIso();
    this.db
      .prepare('UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(now, now, id);
    const session = this.get(id);
    if (session) this.bus.emit({ type: 'session.upserted', session });
  }
}

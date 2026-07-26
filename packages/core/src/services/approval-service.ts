import { ulid } from 'ulid';
import type { Approval } from '@leon/shared';
import type { LeonDb } from '../db/index.js';
import { approvalFromRow, type ApprovalRow } from '../db/rows.js';
import type { EventBus } from '../events.js';
import { nowIso } from '../util/time.js';

export type Decision =
  | { approved: true }
  | { approved: false; reason: string };

interface PendingEntry {
  resolve: (d: Decision) => void;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * Human-in-the-loop gate. `request()` persists a pending Approval, pushes it
 * to the UIs, and returns a promise that resolves when the user decides (or
 * the TTL expires → deny). Callers report back with markExecuted/markFailed
 * so the audit trail and UI reflect what actually happened.
 */
export class ApprovalService {
  private pending = new Map<string, PendingEntry>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private db: LeonDb,
    private bus: EventBus,
  ) {
    // approvals pending from a previous daemon run can never resolve — expire them
    this.db
      .prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending'")
      .run(nowIso());
  }

  start(): void {
    this.sweeper = setInterval(() => this.sweepExpired(), 5_000);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    // resolve anything still waiting so the agent isn't stuck on shutdown
    for (const [id, entry] of this.pending) {
      entry.resolve({ approved: false, reason: 'daemon shutting down' });
      this.pending.delete(id);
    }
  }

  listPending(): Approval[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at")
      .all() as ApprovalRow[];
    return rows.map(approvalFromRow);
  }

  get(id: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | ApprovalRow
      | undefined;
    return row ? approvalFromRow(row) : null;
  }

  request(params: {
    toolName: string;
    toolInput: unknown;
    summary: string;
    risk: Approval['risk'];
    ttlMs?: number;
  }): { approval: Approval; decision: Promise<Decision> } {
    const id = ulid();
    const now = nowIso();
    const ttl = params.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAt = new Date(Date.now() + ttl).toISOString();
    this.db
      .prepare(
        `INSERT INTO approvals (id, chat_message_id, tool_name, tool_input, summary, risk, status, created_at, expires_at)
         VALUES (?, NULL, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, params.toolName, JSON.stringify(params.toolInput ?? null), params.summary, params.risk, now, expiresAt);

    const approval = this.get(id)!;
    this.bus.emit({ type: 'approval.requested', approval });

    const decision = new Promise<Decision>((resolve) => {
      this.pending.set(id, { resolve, expiresAt: Date.now() + ttl });
    });
    return { approval, decision };
  }

  /** User decision from the UI. Returns the updated approval, or null when
   * unknown / no longer pending (the HTTP layer maps that to 404/409). */
  decide(
    id: string,
    approve: boolean,
    reason: string | undefined,
    via: 'web' | 'tui',
  ): Approval | null {
    const current = this.get(id);
    if (!current || current.status !== 'pending') return null;
    this.db
      .prepare('UPDATE approvals SET status = ?, decided_at = ?, decided_via = ? WHERE id = ?')
      .run(approve ? 'approved' : 'denied', nowIso(), via, id);
    const updated = this.get(id)!;
    this.bus.emit({ type: 'approval.resolved', approval: updated });

    const entry = this.pending.get(id);
    if (entry) {
      this.pending.delete(id);
      entry.resolve(
        approve ? { approved: true } : { approved: false, reason: reason?.trim() || 'denied by user' },
      );
    }
    return updated;
  }

  markExecuted(id: string, resultSummary: string): void {
    this.finish(id, 'executed', resultSummary);
    this.audit('approval_executed', id, resultSummary);
  }

  markFailed(id: string, resultSummary: string): void {
    this.finish(id, 'failed', resultSummary);
    this.audit('approval_failed', id, resultSummary);
  }

  private finish(id: string, status: 'executed' | 'failed', resultSummary: string): void {
    this.db
      .prepare('UPDATE approvals SET status = ?, result_summary = ? WHERE id = ?')
      .run(status, resultSummary.slice(0, 1000), id);
    const approval = this.get(id);
    if (approval) this.bus.emit({ type: 'approval.resolved', approval });
  }

  private audit(kind: string, approvalId: string, summary: string): void {
    this.db
      .prepare('INSERT INTO audit_events (id, at, kind, approval_id, payload) VALUES (?, ?, ?, ?, ?)')
      .run(ulid(), nowIso(), kind, approvalId, JSON.stringify({ summary: summary.slice(0, 500) }));
  }

  private sweepExpired(): void {
    const cutoff = Date.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt > cutoff) continue;
      this.pending.delete(id);
      this.db
        .prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'")
        .run(nowIso(), id);
      const approval = this.get(id);
      if (approval) this.bus.emit({ type: 'approval.resolved', approval });
      entry.resolve({ approved: false, reason: 'approval expired before the user decided' });
    }
  }
}

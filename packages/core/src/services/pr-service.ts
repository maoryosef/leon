import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { ulid } from 'ulid';
import type { PullRequest } from '@leon/shared';
import type { LeonDb } from '../db/index.js';
import { prFromRow, type PullRequestRow } from '../db/rows.js';
import type { EventBus } from '../events.js';
import type { SessionService } from './session-service.js';
import { nowIso } from '../util/time.js';

const execFileP = promisify(execFile);

interface GhPr {
  number: number;
  title: string;
  url: string;
  state: string; // OPEN | MERGED | CLOSED
  isDraft: boolean;
  headRefName: string;
  reviewDecision: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  statusCheckRollup: { conclusion?: string; status?: string }[] | null;
}

/**
 * Polls `gh` for the PR of each live session's current branch. Attribution
 * is direct: the session's worktree branch → its PR → the session's task.
 */
export class PrPoller {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private db: LeonDb,
    private bus: EventBus,
    private sessions: SessionService,
    private pollMs: number,
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  list(): PullRequest[] {
    const rows = this.db
      .prepare('SELECT * FROM pull_requests ORDER BY last_synced_at DESC')
      .all() as PullRequestRow[];
    return rows.map(prFromRow);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const active = this.sessions.listActive().filter((s) => s.status !== 'dead');
      const seenCwds = new Set<string>();
      for (const session of active) {
        if (seenCwds.has(session.cwd)) continue;
        seenCwds.add(session.cwd);
        await this.syncSessionPr(session.id, session.taskId ?? null, session.cwd);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async syncSessionPr(
    sessionId: string,
    taskId: string | null,
    cwd: string,
  ): Promise<void> {
    try {
      const { stdout: rootOut } = await execFileP(
        'git',
        ['-C', cwd, 'rev-parse', '--show-toplevel'],
        { timeout: 5000 },
      );
      const repoRoot = rootOut.trim();
      const { stdout: prOut } = await execFileP(
        'gh',
        [
          'pr',
          'view',
          '--json',
          'number,title,url,state,isDraft,headRefName,reviewDecision,statusCheckRollup',
        ],
        { cwd: repoRoot, timeout: 15_000 },
      );
      const pr = JSON.parse(prOut) as GhPr;
      this.upsert(repoRoot, pr, taskId, sessionId);
    } catch {
      // not a git repo / not authed / no PR for branch — all fine, skip
    }
  }

  private upsert(repoRoot: string, pr: GhPr, taskId: string | null, sessionId: string): void {
    const repoId = this.ensureRepo(repoRoot);
    const state: PullRequest['state'] =
      pr.state === 'MERGED'
        ? 'merged'
        : pr.state === 'CLOSED'
          ? 'closed'
          : pr.isDraft
            ? 'draft'
            : 'open';
    const checks = summarizeChecks(pr.statusCheckRollup);
    const review =
      pr.reviewDecision === 'APPROVED'
        ? 'approved'
        : pr.reviewDecision === 'CHANGES_REQUESTED'
          ? 'changes_requested'
          : pr.reviewDecision === 'REVIEW_REQUIRED'
            ? 'review_required'
            : null;
    const now = nowIso();

    const existing = this.db
      .prepare('SELECT id FROM pull_requests WHERE repo_id = ? AND number = ?')
      .get(repoId, pr.number) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE pull_requests SET task_id = COALESCE(?, task_id), session_id = ?,
           branch = ?, title = ?, url = ?, state = ?, checks = ?, review_decision = ?, last_synced_at = ?
           WHERE id = ?`,
        )
        .run(taskId, sessionId, pr.headRefName, pr.title, pr.url, state, checks, review, now, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO pull_requests
           (id, repo_id, task_id, session_id, number, branch, title, url, state, checks, review_decision, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), repoId, taskId, sessionId, pr.number, pr.headRefName, pr.title, pr.url, state, checks, review, now);
    }
    const row = this.db
      .prepare('SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?')
      .get(repoId, pr.number) as PullRequestRow;
    this.bus.emit({ type: 'pr.upserted', pullRequest: prFromRow(row) });
  }

  private ensureRepo(path: string): string {
    const existing = this.db.prepare('SELECT id FROM repos WHERE path = ?').get(path) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
    const id = ulid();
    this.db
      .prepare('INSERT INTO repos (id, path, name, default_branch) VALUES (?, ?, ?, ?)')
      .run(id, path, basename(path), 'main');
    return id;
  }
}

function summarizeChecks(rollup: GhPr['statusCheckRollup']): PullRequest['checks'] {
  if (!rollup || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup) {
    const concl = (c.conclusion ?? '').toUpperCase();
    const status = (c.status ?? '').toUpperCase();
    if (concl === 'FAILURE' || concl === 'TIMED_OUT' || concl === 'CANCELLED') return 'failing';
    if (!concl || status === 'IN_PROGRESS' || status === 'QUEUED' || status === 'PENDING') {
      pending = true;
    }
  }
  return pending ? 'pending' : 'passing';
}

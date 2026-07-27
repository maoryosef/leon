import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ulid } from 'ulid';
import type { PullRequest } from '@leon/shared';
import type { LeonDb } from '../db/index.js';
import { prFromRow, type PullRequestRow } from '../db/rows.js';
import type { EventBus } from '../events.js';
import type { SessionService } from './session-service.js';
import { nowIso } from '../util/time.js';

const execFileP = promisify(execFile);

interface GhPrView {
  number: number;
  title: string;
  url: string;
  state: string; // OPEN | MERGED | CLOSED
  isDraft: boolean;
  headRefName: string;
  reviewDecision: string;
  author: { login?: string } | null;
  statusCheckRollup: { name?: string; context?: string; conclusion?: string; status?: string; state?: string }[] | null;
}

interface BranchInfo {
  nameWithOwner: string;
  branch: string;
  sessionId: string;
  taskId: string | null;
}

const PR_VIEW_FIELDS =
  'number,title,url,state,isDraft,headRefName,reviewDecision,author,statusCheckRollup';

/**
 * Monitors pull requests two ways, unified by `owner/repo#number`:
 *  1. a global sweep of every open PR authored by the user (gh search), so
 *     Leon watches ALL your PRs, not just ones with a live session;
 *  2. the PR of each live session's current branch, which also attributes
 *     PRs to sessions/tasks.
 * Emits `pr.upserted` only when something meaningful changed, and detects
 * merged/closed by re-checking PRs that drop out of the open set.
 */
export class PrPoller {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** The gh-authenticated user; only PRs they authored are tracked. */
  private login: string | null = null;
  private purged = false;
  /** repoRoot -> nameWithOwner (null = not a github repo / gh failed) */
  private repoNameCache = new Map<string, string | null>();
  /** "owner/repo#n" fingerprints for change detection */
  private fingerprints = new Map<string, string>();
  private openKeys = new Set<string>();
  private seeded = false;

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
      if (!this.seeded) {
        this.seedOpenKeysFromDb();
        this.seeded = true;
      }
      const branches = await this.collectSessionBranches();
      const targets = new Map<string, BranchInfo | undefined>(); // key -> attribution

      // 1) all open PRs authored by the user
      for (const { repo, number } of await this.searchMyOpenPrs()) {
        targets.set(`${repo}#${number}`, undefined);
      }
      // 2) PRs for live session branches (attribution + non-authored PRs)
      for (const b of branches) {
        const num = await this.prNumberForBranch(b.nameWithOwner, b.branch);
        if (num !== null) targets.set(`${b.nameWithOwner}#${num}`, b);
      }

      const login = await this.ghLogin();
      const stillOpen = new Set<string>();
      for (const [key, attribution] of targets) {
        const [repo, numStr] = key.split('#') as [string, string];
        const view = await this.viewPr(repo, Number(numStr));
        if (!view) continue;
        // Only the user's own PRs are tracked — session branches can carry
        // other people's PRs, and those are noise here.
        if (login && view.author?.login && view.author.login !== login) {
          this.deleteTracked(repo, view.number);
          continue;
        }
        const attr =
          attribution ??
          branches.find((b) => b.nameWithOwner === repo && b.branch === view.headRefName);
        this.upsert(repo, view, attr ?? null);
        if (view.state === 'OPEN') stillOpen.add(key);
      }

      // PRs that were open last time but aren't in the target set anymore:
      // they merged/closed (or the search missed them) — check them once.
      for (const key of this.openKeys) {
        if (stillOpen.has(key) || targets.has(key)) continue;
        const [repo, numStr] = key.split('#') as [string, string];
        const view = await this.viewPr(repo, Number(numStr));
        if (view) this.upsert(repo, view, null);
      }
      this.openKeys = stillOpen;

      // Boot-time reconcile: purge stored rows not authored by the user (or
      // no longer accessible via gh). Once per daemon run — the intake
      // filter above keeps new foreign PRs out.
      if (!this.purged) {
        await this.purgeForeignRows(login, targets);
        if (login) this.purged = true;
      }
    } catch {
      // gh unavailable / offline — try again next tick
    } finally {
      this.ticking = false;
    }
  }

  private seedOpenKeysFromDb(): void {
    // merged/closed rows are hidden in the UI; prune them after a week so
    // the table doesn't accumulate finished business forever
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const stale = this.db
      .prepare(
        "SELECT id FROM pull_requests WHERE state IN ('merged','closed') AND last_synced_at < ?",
      )
      .all(cutoff) as { id: string }[];
    for (const { id } of stale) {
      this.db.prepare('DELETE FROM pull_requests WHERE id = ?').run(id);
      this.bus.emit({ type: 'pr.deleted', pullRequestId: id });
    }

    const rows = this.db
      .prepare(
        `SELECT r.name AS repo, p.number FROM pull_requests p
         JOIN repos r ON r.id = p.repo_id WHERE p.state IN ('open', 'draft')`,
      )
      .all() as { repo: string; number: number }[];
    for (const r of rows) this.openKeys.add(`${r.repo}#${r.number}`);
  }

  private async ghLogin(): Promise<string | null> {
    if (this.login) return this.login;
    try {
      const { stdout } = await execFileP('gh', ['api', 'user', '-q', '.login'], {
        timeout: 15_000,
      });
      this.login = stdout.trim() || null;
    } catch {
      this.login = null; // offline — skip author filtering this tick
    }
    return this.login;
  }

  /** Remove a tracked PR row (wrong author / gone) and tell the UIs. */
  private deleteTracked(nameWithOwner: string, number: number): void {
    const row = this.db
      .prepare(
        `SELECT p.id FROM pull_requests p JOIN repos r ON r.id = p.repo_id
         WHERE r.name = ? AND p.number = ?`,
      )
      .get(nameWithOwner, number) as { id: string } | undefined;
    if (!row) return;
    this.db.prepare('DELETE FROM pull_requests WHERE id = ?').run(row.id);
    this.fingerprints.delete(`${nameWithOwner}#${number}`);
    this.openKeys.delete(`${nameWithOwner}#${number}`);
    this.bus.emit({ type: 'pr.deleted', pullRequestId: row.id });
  }

  /** One pass over stored rows: drop PRs by other authors and PRs gh can no
   * longer see (stale repos, lost access). Rows already handled this tick
   * are skipped. */
  private async purgeForeignRows(
    login: string | null,
    handled: Map<string, unknown>,
  ): Promise<void> {
    if (!login) return;
    const rows = this.db
      .prepare(
        `SELECT p.number, r.name AS repo FROM pull_requests p JOIN repos r ON r.id = p.repo_id`,
      )
      .all() as { number: number; repo: string }[];
    for (const row of rows) {
      const key = `${row.repo}#${row.number}`;
      if (handled.has(key)) continue;
      const view = await this.viewPr(row.repo, row.number);
      if (!view || (view.author?.login && view.author.login !== login)) {
        this.deleteTracked(row.repo, row.number);
      }
    }
  }

  private async searchMyOpenPrs(): Promise<{ repo: string; number: number }[]> {
    try {
      const { stdout } = await execFileP(
        'gh',
        ['search', 'prs', '--author=@me', '--state=open', '--json', 'repository,number', '--limit', '50'],
        { timeout: 20_000 },
      );
      const parsed = JSON.parse(stdout) as { repository: { nameWithOwner: string }; number: number }[];
      return parsed.map((p) => ({ repo: p.repository.nameWithOwner, number: p.number }));
    } catch {
      return [];
    }
  }

  private async collectSessionBranches(): Promise<BranchInfo[]> {
    const out: BranchInfo[] = [];
    const seenRoots = new Set<string>();
    for (const s of this.sessions.listActive()) {
      if (s.status === 'dead') continue;
      try {
        const { stdout: rootOut } = await execFileP(
          'git',
          ['-C', s.cwd, 'rev-parse', '--show-toplevel'],
          { timeout: 5000 },
        );
        const root = rootOut.trim();
        if (seenRoots.has(root)) continue;
        seenRoots.add(root);
        const nameWithOwner = await this.repoName(root);
        if (!nameWithOwner) continue;
        const { stdout: branchOut } = await execFileP(
          'git',
          ['-C', root, 'branch', '--show-current'],
          { timeout: 5000 },
        );
        const branch = branchOut.trim();
        if (!branch) continue;
        out.push({ nameWithOwner, branch, sessionId: s.id, taskId: s.taskId ?? null });
      } catch {
        // not a repo — skip
      }
    }
    return out;
  }

  private async repoName(root: string): Promise<string | null> {
    if (this.repoNameCache.has(root)) return this.repoNameCache.get(root)!;
    let name: string | null = null;
    try {
      const { stdout } = await execFileP(
        'gh',
        ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
        { cwd: root, timeout: 15_000 },
      );
      name = stdout.trim() || null;
    } catch {
      name = null;
    }
    this.repoNameCache.set(root, name);
    return name;
  }

  private async prNumberForBranch(repo: string, branch: string): Promise<number | null> {
    try {
      const { stdout } = await execFileP(
        'gh',
        ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1'],
        { timeout: 15_000 },
      );
      const arr = JSON.parse(stdout) as { number: number }[];
      return arr[0]?.number ?? null;
    } catch {
      return null;
    }
  }

  private async viewPr(repo: string, number: number): Promise<GhPrView | null> {
    try {
      const { stdout } = await execFileP(
        'gh',
        ['pr', 'view', String(number), '--repo', repo, '--json', PR_VIEW_FIELDS],
        { timeout: 15_000 },
      );
      return JSON.parse(stdout) as GhPrView;
    } catch {
      return null;
    }
  }

  /** PRs advertise their ticket ("feat: ... (ENG-3355)", branch eng-3355-x):
   * match against board tasks' jiraKeys for zero-click attribution. */
  private taskIdFromJiraKey(title: string, branch: string): string | null {
    const keys = `${title} ${branch}`.toUpperCase().match(/[A-Z][A-Z0-9]{1,9}-\d{1,6}/g);
    if (!keys) return null;
    const rows = this.db
      .prepare(
        "SELECT id, jira_key FROM tasks WHERE jira_key IS NOT NULL AND status IN ('active','paused')",
      )
      .all() as { id: string; jira_key: string }[];
    for (const key of keys) {
      const hit = rows.find((row) => row.jira_key.toUpperCase() === key);
      if (hit) return hit.id;
    }
    return null;
  }

  private upsert(nameWithOwner: string, pr: GhPrView, attr: BranchInfo | null): void {
    const repoId = this.ensureRepo(nameWithOwner);
    const state: PullRequest['state'] =
      pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open';
    const checks = summarizeChecks(pr.statusCheckRollup);
    const review =
      pr.reviewDecision === 'APPROVED'
        ? 'approved'
        : pr.reviewDecision === 'CHANGES_REQUESTED'
          ? 'changes_requested'
          : pr.reviewDecision === 'REVIEW_REQUIRED'
            ? 'review_required'
            : null;

    const taskId = attr?.taskId ?? this.taskIdFromJiraKey(pr.title, pr.headRefName);

    const key = `${nameWithOwner}#${pr.number}`;
    const fingerprint = JSON.stringify([state, checks, review, pr.title, taskId, attr?.sessionId]);
    const unchanged = this.fingerprints.get(key) === fingerprint;
    this.fingerprints.set(key, fingerprint);

    const now = nowIso();
    const existing = this.db
      .prepare('SELECT id FROM pull_requests WHERE repo_id = ? AND number = ?')
      .get(repoId, pr.number) as { id: string } | undefined;

    if (existing) {
      if (unchanged) {
        this.db
          .prepare('UPDATE pull_requests SET last_synced_at = ? WHERE id = ?')
          .run(now, existing.id);
        return;
      }
      this.db
        .prepare(
          `UPDATE pull_requests SET task_id = COALESCE(?, task_id), session_id = COALESCE(?, session_id),
           branch = ?, title = ?, url = ?, state = ?, checks = ?, review_decision = ?, last_synced_at = ?
           WHERE id = ?`,
        )
        .run(taskId, attr?.sessionId ?? null, pr.headRefName, pr.title, pr.url, state, checks, review, now, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO pull_requests
           (id, repo_id, task_id, session_id, number, branch, title, url, state, checks, review_decision, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ulid(), repoId, taskId, attr?.sessionId ?? null, pr.number, pr.headRefName, pr.title, pr.url, state, checks, review, now);
    }
    const row = this.db
      .prepare('SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?')
      .get(repoId, pr.number) as PullRequestRow;
    this.bus.emit({ type: 'pr.upserted', pullRequest: prFromRow(row) });
  }

  /** Repos are identified by owner/repo; `path` holds a gh: pseudo-path. */
  private ensureRepo(nameWithOwner: string): string {
    const path = `gh:${nameWithOwner}`;
    const existing = this.db.prepare('SELECT id FROM repos WHERE path = ?').get(path) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
    const id = ulid();
    this.db
      .prepare('INSERT INTO repos (id, path, name, default_branch, remote_url) VALUES (?, ?, ?, ?, ?)')
      .run(id, path, nameWithOwner, 'main', `https://github.com/${nameWithOwner}`);
    return id;
  }
}

function summarizeChecks(rollup: GhPrView['statusCheckRollup']): PullRequest['checks'] {
  if (!rollup || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup) {
    const concl = (c.conclusion ?? c.state ?? '').toUpperCase();
    const status = (c.status ?? '').toUpperCase();
    if (concl === 'FAILURE' || concl === 'TIMED_OUT' || concl === 'CANCELLED' || concl === 'ERROR') {
      return 'failing';
    }
    if (!concl || status === 'IN_PROGRESS' || status === 'QUEUED' || status === 'PENDING' || status === 'WAITING') {
      pending = true;
    }
  }
  return pending ? 'pending' : 'passing';
}

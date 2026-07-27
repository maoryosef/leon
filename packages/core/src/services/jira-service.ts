import type { JiraIssue } from '@leon/shared';
import type { LeonDb } from '../db/index.js';
import type { EventBus } from '../events.js';
import { nowIso } from '../util/time.js';

interface JiraRow {
  key: string;
  summary: string;
  status: string;
  status_category: string | null;
  priority: string | null;
  url: string;
  synced_at: string;
}

function fromRow(r: JiraRow): JiraIssue {
  return {
    key: r.key,
    summary: r.summary,
    status: r.status,
    statusCategory: r.status_category,
    priority: r.priority,
    url: r.url,
    syncedAt: r.synced_at,
  };
}

/** Local cache of the user's assigned Jira issues. The agent fills it (it
 * holds the Atlassian MCP auth); the daemon just stores and serves. */
export class JiraService {
  constructor(
    private db: LeonDb,
    private bus: EventBus,
  ) {}

  list(): JiraIssue[] {
    const rows = this.db
      .prepare("SELECT * FROM jira_issues ORDER BY CASE status_category WHEN 'In Progress' THEN 0 WHEN 'To Do' THEN 1 ELSE 2 END, key")
      .all() as JiraRow[];
    return rows.map(fromRow);
  }

  replaceAll(issues: Omit<JiraIssue, 'syncedAt'>[]): JiraIssue[] {
    const now = nowIso();
    const insert = this.db.prepare(
      `INSERT INTO jira_issues (key, summary, status, status_category, priority, url, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM jira_issues').run();
      for (const issue of issues) {
        insert.run(
          issue.key,
          issue.summary.slice(0, 300),
          issue.status,
          issue.statusCategory ?? null,
          issue.priority ?? null,
          issue.url,
          now,
        );
      }
    });
    txn();
    const all = this.list();
    this.bus.emit({ type: 'jira.synced', issues: all });
    return all;
  }
}

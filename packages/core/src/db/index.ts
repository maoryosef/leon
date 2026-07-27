import Database from 'better-sqlite3';

const MIGRATIONS: string[] = [
  // 001 — initial schema
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    jira_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    tmux_session_name TEXT NOT NULL,
    tmux_window_index INTEGER NOT NULL,
    tmux_pane_id TEXT NOT NULL,
    pane_pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    claude_session_id TEXT,
    transcript_path TEXT,
    instrumented INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    status_since TEXT NOT NULL,
    status_source TEXT NOT NULL,
    current_activity TEXT,
    last_activity_at TEXT NOT NULL,
    title TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_pane ON sessions(tmux_pane_id);
  CREATE INDEX idx_sessions_task ON sessions(task_id);
  CREATE INDEX idx_sessions_claude ON sessions(claude_session_id);

  CREATE TABLE status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX idx_status_history_session ON status_history(session_id, at);

  CREATE TABLE repos (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    remote_url TEXT
  );

  CREATE TABLE task_repos (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, repo_id)
  );

  CREATE TABLE pull_requests (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    number INTEGER NOT NULL,
    branch TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    state TEXT NOT NULL,
    checks TEXT NOT NULL,
    review_decision TEXT,
    last_synced_at TEXT NOT NULL,
    UNIQUE (repo_id, number)
  );

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    chat_message_id TEXT,
    tool_name TEXT NOT NULL,
    tool_input TEXT NOT NULL,
    summary TEXT NOT NULL,
    risk TEXT NOT NULL,
    status TEXT NOT NULL,
    decided_at TEXT,
    decided_via TEXT,
    result_summary TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    agent_session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT,
    task_id TEXT,
    approval_id TEXT,
    payload TEXT
  );
  `,
  // 002 — repos are now identified by owner/repo (path = "gh:owner/repo");
  // old local-path-keyed rows would duplicate, so reset this cache data
  `
  DELETE FROM pull_requests;
  DELETE FROM repos;
  `,
  // 003 — small key/value store (agent session id, misc daemon state)
  `
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 004 — cache of the user's assigned Jira issues (synced by the agent)
  `
  CREATE TABLE jira_issues (
    key TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    status_category TEXT,
    priority TEXT,
    url TEXT NOT NULL,
    synced_at TEXT NOT NULL
  );
  `,
  // 005 — PR conversation tracking (comments/reviews from others)
  `
  ALTER TABLE pull_requests ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pull_requests ADD COLUMN last_comment_author TEXT;
  ALTER TABLE pull_requests ADD COLUMN last_comment_at TEXT;
  `,
];

export type LeonDb = Database.Database;

export function openDb(path: string): LeonDb {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: LeonDb): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = db.prepare('SELECT MAX(idx) AS m FROM _migrations').get() as {
    m: number | null;
  };
  const start = (applied.m ?? -1) + 1;
  for (let i = start; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i]!;
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (idx, applied_at) VALUES (?, ?)').run(
        i,
        new Date().toISOString(),
      );
    });
    run();
  }
}

import { ulid } from 'ulid';
import type { CreateTaskInput, Task, UpdateTaskInput } from '@leon/shared';
import type { LeonDb } from '../db/index.js';
import { sessionFromRow, taskFromRow, type SessionRow, type TaskRow } from '../db/rows.js';
import type { EventBus } from '../events.js';
import { nowIso } from '../util/time.js';

export class TaskService {
  constructor(
    private db: LeonDb,
    private bus: EventBus,
  ) {}

  list(): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as TaskRow[];
    return rows.map(taskFromRow);
  }

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  create(input: CreateTaskInput, source: Task['source'] = 'manual'): Task {
    const now = nowIso();
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, source, jira_key, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(id, input.title, input.description ?? null, source, input.jiraKey ?? null, now, now);
    const task = this.get(id)!;
    this.bus.emit({ type: 'task.upserted', task });
    return task;
  }

  update(id: string, input: UpdateTaskInput): Task | null {
    const current = this.get(id);
    if (!current) return null;
    this.db
      .prepare(
        `UPDATE tasks SET title = ?, description = ?, status = ?, jira_key = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.title ?? current.title,
        input.description === undefined ? (current.description ?? null) : input.description,
        input.status ?? current.status,
        input.jiraKey === undefined ? (current.jiraKey ?? null) : input.jiraKey,
        nowIso(),
        id,
      );
    const task = this.get(id)!;
    this.bus.emit({ type: 'task.upserted', task });
    return task;
  }

  delete(id: string): boolean {
    // sessions.task_id has ON DELETE SET NULL — affected sessions drop to Inbox
    const affected = this.db
      .prepare('SELECT id FROM sessions WHERE task_id = ? AND archived_at IS NULL')
      .all(id) as { id: string }[];
    const res = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    if (res.changes === 0) return false;
    this.bus.emit({ type: 'task.deleted', taskId: id });
    for (const { id: sid } of affected) {
      const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) as
        | SessionRow
        | undefined;
      if (row) this.bus.emit({ type: 'session.upserted', session: sessionFromRow(row) });
    }
    return true;
  }
}

import type { LeonDb } from '../db/index.js';
import type { EventBus } from '../events.js';
import { nowIso } from '../util/time.js';

/** One shared markdown pad (kv-backed): the user's thoughts/todos, readable
 * and (with approval) editable by Leon. Last write wins — single user. */
export class ScratchpadService {
  constructor(
    private db: LeonDb,
    private bus: EventBus,
  ) {}

  get(): { content: string; updatedAt: string | null } {
    const row = (key: string) =>
      (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)
        ?.value ?? null;
    return { content: row('scratchpad') ?? '', updatedAt: row('scratchpad_updated_at') };
  }

  set(content: string, origin: 'user' | 'leon'): { content: string; updatedAt: string } {
    const updatedAt = nowIso();
    const put = this.db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    put.run('scratchpad', content);
    put.run('scratchpad_updated_at', updatedAt);
    this.bus.emit({ type: 'scratchpad.updated', content, updatedAt, origin });
    return { content, updatedAt };
  }
}

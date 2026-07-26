import { ulid } from 'ulid';
import type { ChatContent, ChatMessage } from '@leon/shared';
import type { LeonDb } from '../db/index.js';
import type { EventBus } from '../events.js';
import { nowIso } from '../util/time.js';

interface ChatRow {
  id: string;
  agent_session_id: string;
  role: string;
  content: string;
  created_at: string;
}

function fromRow(r: ChatRow): ChatMessage {
  return {
    id: r.id,
    agentSessionId: r.agent_session_id,
    role: r.role as ChatMessage['role'],
    content: JSON.parse(r.content) as ChatContent,
    createdAt: r.created_at,
  };
}

export class ChatService {
  constructor(
    private db: LeonDb,
    private bus: EventBus,
  ) {}

  list(limit = 200): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_messages ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as ChatRow[];
    return rows.reverse().map(fromRow);
  }

  append(role: ChatMessage['role'], content: ChatContent, agentSessionId: string): ChatMessage {
    const row: ChatRow = {
      id: ulid(),
      agent_session_id: agentSessionId,
      role,
      content: JSON.stringify(content),
      created_at: nowIso(),
    };
    this.db
      .prepare(
        'INSERT INTO chat_messages (id, agent_session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(row.id, row.agent_session_id, row.role, row.content, row.created_at);
    const message = fromRow(row);
    this.bus.emit({ type: 'chat.message', message });
    return message;
  }

  getKv(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}

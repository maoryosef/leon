import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { LeonCore } from '@leon/core';
import type { PtyManager } from '../pty/pty-manager.js';

const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
]);

/**
 * Bridges xterm.js ↔ node-pty(tmux). Server→client frames are binary raw
 * terminal bytes; client→server frames are JSON text (input/resize).
 * mode=peek never forwards input — read-only is enforced HERE, not client-side.
 */
export function registerTerminalSocket(
  app: FastifyInstance,
  core: LeonCore,
  ptys: PtyManager,
): void {
  app.get('/ws/term/:sessionId', { websocket: true }, (socket: WebSocket, req) => {
    const { sessionId } = req.params as { sessionId: string };
    const query = req.query as { mode?: string; cols?: string; rows?: string };
    const mode = query.mode === 'attach' ? 'attach' : 'peek';

    const session = core.sessions.get(sessionId);
    if (!session || session.archivedAt || session.status === 'dead') {
      socket.close(4404, 'session not available');
      return;
    }

    // Register the message listener BEFORE the async pty open — frames the
    // client sends right after its `open` event (initial resize, early
    // keystrokes) must be buffered, not dropped.
    let handle: Awaited<ReturnType<PtyManager['open']>> | null = null;
    let closed = false;
    const pending: z.infer<typeof ClientFrame>[] = [];

    const applyFrame = (frame: z.infer<typeof ClientFrame>) => {
      if (!handle) return;
      if (frame.type === 'resize') {
        handle.resize(frame.cols, frame.rows);
      } else if (frame.type === 'input' && mode === 'attach') {
        handle.write(frame.data);
      }
    };

    socket.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let frame: z.infer<typeof ClientFrame>;
      try {
        frame = ClientFrame.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        return;
      }
      if (handle) applyFrame(frame);
      else pending.push(frame);
    });
    socket.on('close', () => {
      closed = true;
      handle?.close();
    });
    socket.on('error', () => {
      closed = true;
      handle?.close();
    });

    void (async () => {
      let opened: Awaited<ReturnType<PtyManager['open']>>;
      try {
        opened = await ptys.open(session, Number(query.cols) || 120, Number(query.rows) || 30);
      } catch (err) {
        socket.close(4429, err instanceof Error ? err.message : 'pty failed');
        return;
      }
      if (closed) {
        opened.close();
        return;
      }
      handle = opened;
      opened.onData((data) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(Buffer.from(data, 'utf8'));
        }
      });
      opened.onExit(() => socket.close(1000, 'terminal exited'));
      for (const frame of pending.splice(0)) applyFrame(frame);
    })();
  });
}

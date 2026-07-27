import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { LeonCore } from '@leon/core';
import { approvalFromRow } from '@leon/core';
import type { WsEvent } from '@leon/shared';

export function registerEventsSocket(app: FastifyInstance, core: LeonCore): void {
  app.get('/ws/events', { websocket: true }, (socket: WebSocket) => {
    const snapshot: WsEvent = {
      type: 'snapshot',
      tasks: core.tasks.list(),
      sessions: core.sessions.listActive(),
      pullRequests: core.prs.list(),
      approvals: (
        core.db.prepare("SELECT * FROM approvals WHERE status = 'pending'").all() as never[]
      ).map(approvalFromRow),
      jiraIssues: core.jira.list(),
    };
    socket.send(JSON.stringify(snapshot));

    const unsubscribe = core.bus.on((event) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
}

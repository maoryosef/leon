import type { FastifyInstance } from 'fastify';
import type { LeonCore } from '@leon/core';
import { approvalFromRow } from '@leon/core';
import {
  CreateTaskInput,
  LinkSessionInput,
  UpdateSessionInput,
  UpdateTaskInput,
} from '@leon/shared';

export function registerRoutes(app: FastifyInstance, core: LeonCore): void {
  app.get('/api/state', async () => ({
    tasks: core.tasks.list(),
    sessions: core.sessions.listActive(),
    pullRequests: core.prs.list(),
    approvals: (
      core.db.prepare("SELECT * FROM approvals WHERE status = 'pending'").all() as never[]
    ).map(approvalFromRow),
  }));

  app.post('/api/tasks', async (req, reply) => {
    const input = CreateTaskInput.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.message });
    return core.tasks.create(input.data);
  });

  app.patch('/api/tasks/:id', async (req, reply) => {
    const input = UpdateTaskInput.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.message });
    const task = core.tasks.update((req.params as { id: string }).id, input.data);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return task;
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const ok = core.tasks.delete((req.params as { id: string }).id);
    return reply.code(ok ? 204 : 404).send();
  });

  app.post('/api/sessions/:id/link', async (req, reply) => {
    const input = LinkSessionInput.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.message });
    const session = core.sessions.link((req.params as { id: string }).id, input.data.taskId);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return session;
  });

  app.patch('/api/sessions/:id', async (req, reply) => {
    const input = UpdateSessionInput.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: input.error.message });
    const id = (req.params as { id: string }).id;
    const session =
      input.data.title !== undefined
        ? core.sessions.setTitle(id, input.data.title)
        : core.sessions.get(id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    return session;
  });

  app.get('/api/sessions/:id/capture', async (req, reply) => {
    const session = core.sessions.get((req.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    try {
      const text = await core.tmux.capturePane(session.tmuxPaneId);
      return { text };
    } catch {
      return reply.code(410).send({ error: 'pane is gone' });
    }
  });
}

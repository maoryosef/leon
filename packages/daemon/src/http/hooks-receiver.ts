import type { FastifyInstance } from 'fastify';
import type { LeonCore } from '@leon/core';
import { HookPayload } from '@leon/shared';

/**
 * Receives POSTs from the `leon-hook` script running inside child Claude
 * Code sessions. Must be fast and never error the child: any failure is
 * swallowed into a 200/4xx without consequence (the script also ignores
 * failures on its side).
 */
export function registerHooksReceiver(app: FastifyInstance, core: LeonCore): void {
  app.post('/hooks', async (req, reply) => {
    // leon-hook passes Leon identity via query params (simpler than editing
    // JSON in POSIX sh); merge them into the payload before validation.
    const q = req.query as { leon_session_id?: string; leon_pane_id?: string };
    const body =
      typeof req.body === 'object' && req.body !== null
        ? {
            ...(req.body as Record<string, unknown>),
            ...(q.leon_session_id ? { leon_session_id: q.leon_session_id } : {}),
            ...(q.leon_pane_id ? { leon_pane_id: q.leon_pane_id } : {}),
          }
        : req.body;
    const parsed = HookPayload.safeParse(body);
    if (!parsed.success) {
      req.log.warn({ err: parsed.error.message }, 'unparseable hook payload');
      return reply.code(400).send({ ok: false });
    }
    const session = core.monitor.ingestHook(parsed.data);
    return { ok: true, matched: session?.id ?? null };
  });
}

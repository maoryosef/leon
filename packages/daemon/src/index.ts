import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { createCore } from '@leon/core';
import { registerHooksReceiver } from './http/hooks-receiver.js';
import { registerRoutes } from './http/routes.js';
import { PtyManager } from './pty/pty-manager.js';
import { registerEventsSocket } from './ws/events-socket.js';
import { registerTerminalSocket } from './ws/terminal-socket.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(here, '..', '..', 'web', 'dist');

async function main(): Promise<void> {
  const core = createCore();
  const app = Fastify({ logger: { level: 'info' } });

  await app.register(fastifyWebsocket);

  // ---- auth: every API/WS/hook route requires the bearer token
  const token = core.config.server.token;
  app.addHook('onRequest', (req, reply, done) => {
    const url = req.url;
    const needsAuth =
      url.startsWith('/api') || url.startsWith('/ws') || url.startsWith('/hooks');
    if (!needsAuth) return done();
    const header = req.headers.authorization;
    const provided =
      header?.replace(/^Bearer\s+/i, '') ?? (req.query as { token?: string }).token;
    if (provided !== token) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    done();
  });

  registerRoutes(app, core);
  registerHooksReceiver(app, core);
  registerEventsSocket(app, core);
  registerTerminalSocket(app, core, new PtyManager());

  // ---- built web app (when present); dev uses the vite server instead
  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws') || req.url.startsWith('/hooks')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html'); // SPA fallback
    });
  }

  await core.start();
  try {
    await app.listen({ host: core.config.server.host, port: core.config.server.port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const base = `http://${core.config.server.host}:${core.config.server.port}`;
      const alreadyLeon = await fetch(`${base}/api/state`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      core.stop();
      if (alreadyLeon) {
        // idempotent: an already-healthy daemon is success, not failure —
        // exiting 0 keeps pnpm from burying this message in lifecycle errors
        console.log(
          `\nLeon is already running at ${base} — leaving it as is.\n` +
            `Open the board:      leon ui   (or node packages/cli/bin/leon.js ui)\n` +
            `Restart on new code: pnpm restart`,
        );
        process.exit(0);
      }
      console.error(
        `\nPort ${core.config.server.port} is taken by something that isn't Leon.\n` +
          `Free it (lsof -ti tcp:${core.config.server.port} | xargs kill) or change [server].port in ${core.config.configPath}`,
      );
      process.exit(1);
    }
    throw err;
  }
  app.log.info(
    `leon daemon up — ui: http://${core.config.server.host}:${core.config.server.port}/?token=${token}`,
  );

  const shutdown = async () => {
    app.log.info('shutting down');
    core.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('daemon failed to start:', err);
  process.exit(1);
});

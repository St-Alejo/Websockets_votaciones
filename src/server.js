import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import autoload from '@fastify/autoload';
import websocket from '@fastify/websocket';
import { loadConfig } from './config.js';
import { createRedisClients, registerClients } from './redis/client.js';
import { configureDomain } from './domain/index.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildApp(options = {}) {
  const config = options.config ?? loadConfig();
  const app = Fastify({ logger: options.logger ?? { level: config.logLevel } });

  let { redis, redisSub } = options;
  const ownClients = !redis;
  if (ownClients) {
    ({ redis, redisSub } = createRedisClients(config.redisUrl, {
      commandTimeoutMs: config.redisCommandTimeoutMs,
    }));
    for (const c of [redis, redisSub]) {
      c.on('error', (err) => app.log.warn({ msg: err.message }, 'redis'));
    }
  }
  registerClients({ redis, redisSub });
  configureDomain(config);

  app.decorate('config', config);
  app.decorate('instanceId', config.instanceId);
  app.decorate('redis', redis);
  app.decorate('redisSub', redisSub);

  app.addHook('onRequest', async (_req, reply) => {
    reply.raw.setHeader('X-Instance-Id', config.instanceId);
  });

  await app.register(websocket);
  await app.register(autoload, {
    dir: options.pluginsDir ?? join(here, 'plugins'),
    dirNameRoutePrefix: false,
    ignorePattern: /\.test\.js$/,
  });

  app.addHook('onClose', async () => {
    const close = (c) => (c.status === 'ready' ? c.quit() : c.disconnect());
    if (ownClients) await Promise.allSettled([close(redis), close(redisSub)]);
  });

  return app;
}

async function start() {
  const app = await buildApp();
  const { port, host } = app.config;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      app.log.info(`${signal}: shutting down`);
      await app.close();
      process.exit(0);
    });
  }
  try {
    await app.listen({ port, host });
    app.log.info(`Instance ${app.instanceId} listening on ${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}

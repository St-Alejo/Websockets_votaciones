// Dueño: Persona 1. Nadie más edita este archivo para registrar rutas:
// las rutas se agregan creando archivos en src/plugins/<carpeta-de-cada-persona>/.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import autoload from '@fastify/autoload';
import websocket from '@fastify/websocket';
import { cargarConfig } from './config.js';
import { crearClientesRedis, registrarClientes } from './redis/cliente.js';

const aqui = dirname(fileURLToPath(import.meta.url));

/**
 * Construye la app sin escuchar en un puerto (los tests usan app.inject()).
 * @param {object} [opciones]
 * @param {object} [opciones.config]      config ya cargada (por defecto, de process.env)
 * @param {object} [opciones.redis]       cliente Redis inyectado (tests)
 * @param {object} [opciones.redisSub]    cliente Redis suscriptor inyectado (tests)
 * @param {string} [opciones.dirPlugins]  carpeta a autocargar (por defecto src/plugins)
 * @param {boolean|object} [opciones.logger]
 */
export async function construirApp(opciones = {}) {
  const config = opciones.config ?? cargarConfig();
  const app = Fastify({ logger: opciones.logger ?? { level: config.logLevel } });

  let { redis, redisSub } = opciones;
  const clientesPropios = !redis;
  if (clientesPropios) {
    ({ redis, redisSub } = crearClientesRedis(config.redisUrl));
    for (const c of [redis, redisSub]) c.on('error', (err) => app.log.warn({ err }, 'redis'));
  }
  registrarClientes({ redis, redisSub });

  app.decorate('config', config);
  app.decorate('instanceId', config.instanceId);
  app.decorate('redis', redis);
  app.decorate('redisSub', redisSub);

  // En reply.raw para que también salga en respuestas "hijacked" (SSE).
  app.addHook('onRequest', async (_req, reply) => {
    reply.raw.setHeader('X-Instance-Id', config.instanceId);
  });

  await app.register(websocket);
  await app.register(autoload, {
    dir: opciones.dirPlugins ?? join(aqui, 'plugins'),
    dirNameRoutePrefix: false,
    ignorePattern: /\.test\.js$/,
  });

  app.addHook('onClose', async () => {
    if (clientesPropios) await Promise.allSettled([redis.quit(), redisSub.quit()]);
  });

  return app;
}

async function iniciar() {
  const app = await construirApp();
  const { port, host } = app.config;
  for (const senal of ['SIGINT', 'SIGTERM']) {
    process.once(senal, async () => {
      app.log.info(`${senal}: cerrando`);
      await app.close();
      process.exit(0);
    });
  }
  try {
    await app.listen({ port, host });
    app.log.info(`Instancia ${app.instanceId} escuchando en ${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  iniciar();
}

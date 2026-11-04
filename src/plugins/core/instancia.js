// Dueño: Persona 1. GET /instancia y GET /salud.
import { redisResponde } from '../../redis/cliente.js';

export default async function instancia(app) {
  app.get('/instancia', async () => ({
    instancia: app.instanceId,
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
  }));

  app.get('/salud', async (_req, reply) => {
    const redisOk = await redisResponde(app.redis);
    reply.code(redisOk ? 200 : 503);
    return {
      estado: redisOk ? 'ok' : 'degradado',
      instancia: app.instanceId,
      redis: redisOk ? 'ok' : 'sin_respuesta',
    };
  });
}

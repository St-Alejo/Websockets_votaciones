import { redisResponds } from '../../redis/client.js';

export default async function instance(app) {
  app.get('/instance', async () => ({
    instance: app.instanceId,
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
  }));

  app.get('/health', async (_req, reply) => {
    const redisOk = await redisResponds(app.redis);
    reply.code(redisOk ? 200 : 503);
    return {
      status: redisOk ? 'ok' : 'degraded',
      instance: app.instanceId,
      redis: redisOk ? 'ok' : 'no_response',
      redis_connection: app.redis?.status ?? 'no_client',
    };
  });
}

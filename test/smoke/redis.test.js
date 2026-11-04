import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server.js';
import { waitUntilReady } from '../../src/redis/client.js';
import { TEST_CONFIG } from '../helpers.js';

describe.skipIf(!process.env.REDIS_URL)('with real Redis', () => {
  it('GET /health responds ok with Redis connected', async () => {
    const app = await buildApp({
      config: { ...TEST_CONFIG, redisUrl: process.env.REDIS_URL },
      logger: false,
    });
    await app.ready();
    await waitUntilReady(app.redis);
    const res = await app.inject('/health');
    expect(res.json()).toMatchObject({ status: 'ok', redis: 'ok' });
    await app.close();
  });
});

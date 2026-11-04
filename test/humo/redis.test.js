// Solo corre si hay REDIS_URL (en CI hay un servicio Redis). Localmente:
//   REDIS_URL=redis://localhost:6379 npm test
import { describe, expect, it } from 'vitest';
import { construirApp } from '../../src/server.js';
import { CONFIG_TEST } from '../helpers.js';

describe.skipIf(!process.env.REDIS_URL)('con Redis real', () => {
  it('GET /salud responde ok con Redis conectado', async () => {
    const app = await construirApp({
      config: { ...CONFIG_TEST, redisUrl: process.env.REDIS_URL },
      logger: false,
    });
    await app.ready();
    const res = await app.inject('/salud');
    expect(res.json()).toMatchObject({ estado: 'ok', redis: 'ok' });
    await app.close();
  });
});

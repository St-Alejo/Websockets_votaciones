import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { SAMPLE_TALLY, testApp } from '../helpers.js';

describe('server', () => {
  let app;
  beforeAll(async () => {
    app = await testApp();
    await app.ready();
  });
  afterAll(() => app.close());

  it('starts and listens on a port', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/instance`);
    expect(res.status).toBe(200);
  });

  it('GET /instance responds with the id and the X-Instance-Id header', async () => {
    const res = await app.inject('/instance');
    expect(res.statusCode).toBe(200);
    expect(res.json().instance).toBe('test-1');
    expect(res.headers['x-instance-id']).toBe('test-1');
  });

  it('GET /health reports the Redis status', async () => {
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', redis: 'ok' });
  });

  it('every route carries X-Instance-Id, even a 404', async () => {
    const res = await app.inject('/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-instance-id']).toBe('test-1');
  });

  it('autoload loads the plugins of all 3 owners', async () => {
    const routes = app.printRoutes({ commonPrefix: false });
    for (const r of [
      '/tallies',
      '/totals/',
      '/ranking/',
      '/sse/public',
      '/metrics',
      '/ws/juror',
      '/ws/auditor',
    ]) {
      expect(routes).toContain(r);
    }
  });

  it('POST /tallies with an invalid tally -> 400 rejected (validated before touching Redis)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/tallies',
      payload: { ...SAMPLE_TALLY, votes: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ status: 'rejected', receipt: null });
  });

  it('GET /totals and /ranking validate the level before touching Redis', async () => {
    expect((await app.inject('/totals/country/1')).statusCode).toBe(400);
    expect((await app.inject('/ranking/mun')).statusCode).toBe(400);
  });
});

describe('autoload', () => {
  it('loads a test plugin from the given folder', async () => {
    const dir = fileURLToPath(new URL('../fixtures/plugins', import.meta.url));
    const app = await testApp({ pluginsDir: dir });
    const res = await app.inject('/sample/nested');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, instance: 'test-1' });
    expect(res.headers['x-instance-id']).toBe('test-1');
    await app.close();
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server.js';
import { waitUntilReady } from '../../redis/client.js';
import { hasRedis, urlWithDb } from '../../redis/test.helper.js';
import { TEST_CONFIG } from '../../../test/helpers.js';

describe.skipIf(!(await hasRedis()))(
  'RT-5 the public consumes SSE with a resumable snapshot',
  () => {
    let app;
    let base;
    afterAll(async () => {
      await app?.close().catch(() => null);
    });

    it('emits event: snapshot with id and X-Instance-Id header', async () => {
      app = await buildApp({
        config: { ...TEST_CONFIG, redisUrl: urlWithDb(9) },
        logger: false,
      });
      await waitUntilReady(app.redis);
      await app.listen({ port: 0, host: '127.0.0.1' });
      base = `http://127.0.0.1:${app.server.address().port}`;

      const res = await fetch(`${base}/sse/public?topic=dept`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(res.headers.get('x-instance-id')).toBe('test-1');

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 5000;
      while (!text.includes('event: snapshot') && Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
      await reader.cancel();
      expect(text).toMatch(/event: snapshot/);
      expect(text).toMatch(/^id: /m);
      const data = text.split('data: ')[1];
      expect(JSON.parse(data).levels.dept).toMatchObject({ level: 'dept' });
    });

    it('rejects invalid topics without hanging the connection', async () => {
      const res = await app.inject('/sse/public?topic=country:1');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_topic' });
    });
  },
);

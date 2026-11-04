import http from 'node:http';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { stats, subscribe, subscribers, unsubscribe } from '../../src/fanout/index.js';
import {
  cleanup,
  connectionsOf,
  resetTopics,
  subscribe as addSubscription,
  traverse,
  unsubscribe as removeSubscription,
} from '../../src/fanout/topics.js';
import { SSE_HEADERS, startHeartbeat, writeEvent } from '../../src/transport/sse.js';
import { buildApp } from '../../src/server.js';
import { waitUntilReady } from '../../src/redis/client.js';
import { hasRedis, urlWithDb } from '../../src/redis/test.helper.js';
import { TEST_CONFIG, testApp } from '../../test/helpers.js';

const WITH_REDIS = await hasRedis();

describe('RF-5 topic to connections index', () => {
  beforeEach(() => resetTopics());

  it('add, remove and traversal do not mix topics', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    addSubscription(a, 'mun:11');
    addSubscription(a, 'station:176');
    addSubscription(b, 'mun:11');
    addSubscription(a, 'mun:11');

    expect(connectionsOf('mun:11').size).toBe(2);
    expect([...connectionsOf('station:176')]).toEqual([a]);
    expect(connectionsOf('table:1').size).toBe(0);

    const seen = [];
    expect(traverse('mun:11', (c) => seen.push(c.id))).toBe(2);
    expect(seen).toEqual(['a', 'b']);

    removeSubscription(a, 'mun:11');
    expect([...connectionsOf('mun:11')]).toEqual([b]);
    expect(connectionsOf('station:176').has(a)).toBe(true);

    cleanup(a);
    expect(connectionsOf('station:176').size).toBe(0);
    expect(connectionsOf('mun:11').has(b)).toBe(true);
    cleanup(b);
    expect(stats().topics).toBe(0);
  });

  it('the facade keeps its signature and counts distinct connections', () => {
    expect(subscribe.length).toBe(2);
    expect(unsubscribe.length).toBe(2);
    const connection = { id: 1 };
    subscribe(connection, 'dept');
    subscribe(connection, 'mun:11');
    expect(subscribers('dept').has(connection)).toBe(true);
    expect(stats()).toMatchObject({ topics: 2, subscriptions: 2, connections: 1 });
    unsubscribe(connection, 'dept');
    unsubscribe(connection, 'mun:11');
    expect(stats().subscriptions).toBe(0);
  });
});

describe('SSE: format, headers and heartbeat', () => {
  it('declares the event-stream headers', () => {
    expect(SSE_HEADERS['Content-Type']).toBe('text/event-stream');
    expect(SSE_HEADERS['Cache-Control']).toContain('no-cache');
    expect(SSE_HEADERS.Connection).toBe('keep-alive');
  });

  it('writes an SSE event with id', () => {
    const chunks = [];
    const res = {
      writableEnded: false,
      destroyed: false,
      write(chunk) {
        chunks.push(chunk);
        return true;
      },
    };
    writeEvent(res, { event: 'snapshot', data: { a: 1 }, id: '3-0' });
    expect(chunks[0]).toBe('id: 3-0\nevent: snapshot\ndata: {"a":1}\n\n');
  });

  it('sends ping and destroys the socket if it does not drain', async () => {
    const pings = [];
    const res = {
      destroyed: false,
      writableEnded: false,
      writable: true,
      write(chunk) {
        pings.push(chunk);
        return true;
      },
    };
    const stop = startHeartbeat(res, 20);
    await new Promise((r) => setTimeout(r, 70));
    stop();
    expect(pings.some((c) => c.startsWith(': ping'))).toBe(true);

    const hung = {
      destroyed: false,
      writableEnded: false,
      writable: true,
      destroyedCalled: false,
      write() {
        return false;
      },
      destroy() {
        this.destroyed = true;
        this.destroyedCalled = true;
      },
    };
    const stopHung = startHeartbeat(hung, 10);
    await new Promise((r) => setTimeout(r, 80));
    stopHung();
    expect(hung.destroyedCalled).toBe(true);
  });

  it('GET /sse/public rejects an invalid topic', async () => {
    const app = await testApp();
    const bad = await app.inject('/sse/public?topic=country:1');
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it.skipIf(!WITH_REDIS)('GET /sse/public opens the stream with a snapshot', async () => {
    const app = await buildApp({
      config: { ...TEST_CONFIG, redisUrl: urlWithDb(14) },
      logger: false,
    });
    await waitUntilReady(app.redis);

    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { status, headers, body } = await new Promise((resolve, reject) => {
        const req = http.get(`${base}/sse/public?topic=mun:11`, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
            if (body.includes('event: snapshot')) {
              res.destroy();
              resolve({ status: res.statusCode, headers: res.headers, body });
            }
          });
          res.on('error', () => {
            if (body.includes('event: snapshot')) {
              resolve({ status: res.statusCode, headers: res.headers, body });
            }
          });
        });
        req.on('error', reject);
      });
      expect(status).toBe(200);
      expect(headers['content-type']).toContain('text/event-stream');
      expect(headers['cache-control']).toContain('no-cache');
      expect(headers.connection).toBe('keep-alive');
      expect(body).toContain('retry:');
      expect(body).toContain('event: snapshot');
      expect(body).toContain('"mun:11"');
    } finally {
      resetTopics();
      await app.close();
    }
  });
});

afterAll(() => resetTopics());

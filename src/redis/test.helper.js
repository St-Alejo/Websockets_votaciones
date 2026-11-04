import net from 'node:net';
import { Redis } from 'ioredis';
import { createRedisClients, waitUntilReady } from './client.js';

export const BASE_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export function urlWithDb(db, url = BASE_URL) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export async function hasRedis() {
  if (process.env.REDIS_URL) return true;
  const r = new Redis(BASE_URL, { lazyConnect: true, connectTimeout: 500, retryStrategy: null });
  r.on('error', () => {});
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    console.warn(`[tests] No Redis at ${BASE_URL}: skipping Redis-backed tests.`);
    return false;
  } finally {
    r.disconnect();
  }
}

export async function freezableProxy(target = BASE_URL) {
  const d = new URL(target);
  let frozen = false;
  const pending = [];
  const pairs = new Set();
  const server = net.createServer((client) => {
    const redis = net.connect(Number(d.port || 6379), d.hostname);
    const pair = [client, redis];
    pairs.add(pair);
    const forward = (to) => (bytes) => {
      if (frozen) pending.push(() => to.write(bytes));
      else to.write(bytes);
    };
    client.on('data', forward(redis));
    redis.on('data', forward(client));
    const close = () => {
      pairs.delete(pair);
      client.destroy();
      redis.destroy();
    };
    client.on('close', close).on('error', close);
    redis.on('close', close).on('error', close);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const u = new URL(target);
  u.hostname = '127.0.0.1';
  u.port = String(server.address().port);
  return {
    url: u.toString(),
    freeze() {
      frozen = true;
    },
    unfreeze() {
      frozen = false;
      while (pending.length) pending.shift()();
    },
    async close() {
      for (const [c, r] of pairs) {
        c.destroy();
        r.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function testClient(db, options = {}) {
  const { redis, redisSub } = createRedisClients(urlWithDb(db), options);
  redisSub.disconnect();
  redis.on('error', () => {});
  await waitUntilReady(redis);
  return redis;
}

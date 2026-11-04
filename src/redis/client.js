import { Redis } from 'ioredis';
import { defineCommands } from './scripts.js';

const REGISTRY = Symbol.for('preconteo.redis.clients');
globalThis[REGISTRY] ??= { redis: null, redisSub: null };

export function retryStrategy(attempt) {
  const base = Math.min(100 * 2 ** Math.min(attempt, 5), 2000);
  return base / 2 + Math.random() * (base / 2);
}

export function createRedisClients(url, options = {}) {
  const { commandTimeoutMs = 1000, ...rest } = options;
  const common = { retryStrategy, connectTimeout: 2000, family: 0, ...rest };

  const redis = new Redis(url, {
    ...common,
    connectionName: 'app',
    enableOfflineQueue: false,
    commandTimeout: commandTimeoutMs,
    maxRetriesPerRequest: 0,
  });
  defineCommands(redis);

  const redisSub = new Redis(url, { ...common, connectionName: 'sub' });
  return { redis, redisSub };
}

export function registerClients(clients) {
  globalThis[REGISTRY] = clients;
}

export const getRedis = () => globalThis[REGISTRY]?.redis;
export const getRedisSub = () => globalThis[REGISTRY]?.redisSub;

export function waitUntilReady(redis, timeoutMs = 5000) {
  if (redis.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      redis.off('ready', ready);
      reject(new Error(`Redis was not ready within ${timeoutMs} ms`));
    }, timeoutMs);
    function ready() {
      clearTimeout(t);
      resolve();
    }
    redis.once('ready', ready);
  });
}

export async function redisResponds(redis, timeoutMs = 500) {
  if (!redis) return false;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([redis.ping().then((r) => r === 'PONG'), deadline]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

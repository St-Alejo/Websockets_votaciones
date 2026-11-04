import { afterAll, describe, expect, it } from 'vitest';
import { createRedisClients, retryStrategy, redisResponds } from './client.js';
import { translateRedisError, RedisUnavailableError } from '../domain/errors.js';
import { testClient, hasRedis } from './test.helper.js';

describe('Redis client without a server', () => {
  const { redis, redisSub } = createRedisClients('redis://127.0.0.1:1', { commandTimeoutMs: 300 });
  redis.on('error', () => {});
  redisSub.on('error', () => {});
  afterAll(() => {
    redis.disconnect();
    redisSub.disconnect();
  });

  it('a command fails immediately (no offline queue) and is translated to RedisUnavailableError', async () => {
    const t0 = performance.now();
    const err = await redis.get('x').catch((e) => e);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(translateRedisError(err)).toBeInstanceOf(RedisUnavailableError);
  });

  it('redisResponds returns false quickly', async () => {
    expect(await redisResponds(redis)).toBe(false);
  });

  it('a programming bug (TypeError) is not disguised as a 503', () => {
    const bug = new TypeError("Cannot read properties of null (reading 'x')");
    expect(translateRedisError(bug)).toBe(bug);
  });

  it('backoff is capped at 2 s', () => {
    for (let i = 1; i < 50; i++) expect(retryStrategy(i)).toBeLessThanOrEqual(2000);
  });
});

describe.skipIf(!(await hasRedis()))('Redis client with a real server', () => {
  it('connects and answers PING', async () => {
    const redis = await testClient(9);
    expect(await redisResponds(redis)).toBe(true);
    await redis.quit();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { buildApp } from '../../server.js';
import { waitUntilReady } from '../../redis/client.js';
import { hasRedis, freezableProxy, urlWithDb } from '../../redis/test.helper.js';

const DB = 13;
const BASE = {
  port: 0,
  host: '127.0.0.1',
  instanceId: 'test-p1',
  logLevel: 'silent',
  redisUrl: urlWithDb(DB),
  redisCommandTimeoutMs: 400,
  rlMax: 0,
  rlWindowMs: 60_000,
  streamMaxlen: 10_000,
};

let sequence = 0;
function tally({ juror = 'JUR-1', extra = 0, version = 1, table } = {}) {
  const n = table ?? ++sequence;
  const votes = { C1: 30, C2: 20, C3: 5, BLANK: 2, NULL: 1, UNMARKED: 0 };
  return {
    tally: `E14-7-${n}-03`,
    table: n,
    station: 7,
    municipality: 3,
    version,
    juror,
    closed_at: 1793577600,
    votes,
    voters: 58 + extra,
    photo_hash: 'f',
    idem: `http-${n}-v${version}-${extra}`,
  };
}

async function app(config = {}) {
  const a = await buildApp({ config: { ...BASE, ...config }, logger: false });
  await a.ready();
  return a;
}

const post = (a, payload) => a.inject({ method: 'POST', url: '/tallies', payload });

describe.skipIf(!(await hasRedis()))('tally endpoints with real Redis', () => {
  let a;
  let admin;
  beforeAll(async () => {
    a = await app();
    await waitUntilReady(a.redis);
    admin = new Redis(urlWithDb(DB));
  });
  beforeEach(() => admin.flushdb());
  afterAll(async () => {
    await a?.close();
    await admin?.quit();
  });

  it('POST /tallies: registered (201) and its resend duplicate (200) with the same receipt', async () => {
    const x = tally();
    const r1 = await post(a, x);
    expect(r1.statusCode).toBe(201);
    expect(r1.headers['x-instance-id']).toBe('test-p1');
    expect(r1.json()).toMatchObject({ status: 'registered', current_version: 1 });
    const r2 = await post(a, x);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ status: 'duplicate', receipt: r1.json().receipt });
  });

  it('POST /tallies: doubtful -> 202, conflict -> 409', async () => {
    expect((await post(a, tally({ extra: 4 }))).statusCode).toBe(202);
    const x = tally();
    await post(a, x);
    const r = await post(a, {
      ...x,
      votes: { ...x.votes, C1: 31 },
      voters: 59,
      idem: 'other-1234',
    });
    expect(r.statusCode).toBe(409);
  });

  it('GET /totals and /ranking return the registered data', async () => {
    await post(a, tally());
    await post(a, tally());
    const total = (await a.inject('/totals/station/7')).json();
    expect(total).toMatchObject({ level: 'station', id: '7', tables_reported: 2, voters: 116 });
    expect((await a.inject('/totals/dept')).json().votes.C1).toBe(60);
    expect((await a.inject('/ranking/mun/3?top=2')).json()).toEqual([
      { candidate: 'C1', votes: 60 },
      { candidate: 'C2', votes: 40 },
    ]);
  });
});

describe.skipIf(!(await hasRedis()))('hung Redis (frozen connection)', () => {
  let a;
  let proxy;
  let admin;
  beforeAll(async () => {
    proxy = await freezableProxy(urlWithDb(DB));
    a = await app({ redisUrl: proxy.url });
    await waitUntilReady(a.redis);
    admin = new Redis(urlWithDb(DB));
    await admin.flushdb();
    await post(a, tally());
  });
  afterAll(async () => {
    proxy?.unfreeze();
    await a?.close();
    await admin?.quit();
    await proxy?.close();
  });

  it('POST /tallies: 503 within timeout + margin; after recovery, the retry is idempotent', async () => {
    const x = tally();
    proxy.freeze();
    const t0 = performance.now();
    const r = await post(a, x);
    const ms = performance.now() - t0;
    const health = await a.inject('/health');

    expect(r.statusCode).toBe(503);
    expect(ms).toBeLessThan(BASE.redisCommandTimeoutMs + 300);
    expect(r.headers['retry-after']).toBeDefined();
    expect(r.json()).toMatchObject({ status: 'not_registered', retry: true });
    expect(health.statusCode).toBe(503);

    proxy.unfreeze();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const retry = await post(a, x);
    expect(retry.json().status).toBe('duplicate');
    expect((await a.inject('/totals/dept')).json().votes.C1).toBe(60);
    expect((await a.inject('/health')).statusCode).toBe(200);
  }, 10_000);
});

describe.skipIf(!(await hasRedis()))('rate limit per juror', () => {
  let limited;
  let admin;
  beforeAll(async () => {
    limited = await app({ rlMax: 3, rlWindowMs: 30_000 });
    await waitUntilReady(limited.redis);
    admin = new Redis(urlWithDb(DB));
    await admin.flushdb();
  });
  afterAll(async () => {
    await limited?.close();
    await admin?.quit();
  });

  it('submission #4 from a juror with RL_MAX=3 gets 429 with Retry-After', async () => {
    const codes = [];
    for (let i = 0; i < 4; i++)
      codes.push((await post(limited, tally({ juror: 'JUR-BURST' }))).statusCode);
    expect(codes).toEqual([201, 201, 201, 429]);

    const r = await post(limited, tally({ juror: 'JUR-BURST' }));
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(30);
    expect(r.json()).toMatchObject({ error: 'rate_limited', juror: 'JUR-BURST' });
    expect((await post(limited, tally({ juror: 'JUR-OTHER' }))).statusCode).toBe(201);
  });
});

describe('Redis down (nobody listening on the port)', () => {
  let a;
  beforeAll(async () => {
    a = await app({ redisUrl: 'redis://127.0.0.1:1' });
  });
  afterAll(() => a?.close());

  it('POST /tallies responds with an explicit 503 in under 300 ms', async () => {
    const t0 = performance.now();
    const r = await post(a, tally());
    expect(performance.now() - t0).toBeLessThan(300);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ status: 'not_registered', retry: true });
  });

  it('reads also fail fast with 503 and /health reflects it', async () => {
    expect((await a.inject('/totals/dept')).statusCode).toBe(503);
    const health = await a.inject('/health');
    expect(health.statusCode).toBe(503);
    expect(health.json()).toMatchObject({ status: 'degraded', redis: 'no_response' });
  });

  it('/instance keeps responding (the instance is alive even though degraded)', async () => {
    expect((await a.inject('/instance')).statusCode).toBe(200);
  });
});

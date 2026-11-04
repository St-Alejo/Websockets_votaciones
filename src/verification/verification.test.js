import { afterEach, describe, expect, it } from 'vitest';
import { registerClients } from '../redis/client.js';
import {
  updatePriority,
  enqueueTally,
  getTally,
  pending,
  requeueTally,
  removeTally,
  queueSize,
} from './queue.js';
import { lockOwner, tryLock, releaseLock, renewLock } from './lock.js';
import { stopHeartbeat, startHeartbeat } from './heartbeat.js';
import { releaseCase, resolveCase, takeCase, viewQueue } from './index.js';

function fakeVerificationRedis() {
  const zsets = new Map();
  const strings = new Map();
  const published = [];

  function live(key) {
    const e = strings.get(key);
    if (!e) return null;
    if (e.expiresMs !== null && Date.now() >= e.expiresMs) {
      strings.delete(key);
      return null;
    }
    return e;
  }

  function compareToken(raw, token) {
    if (raw === null) return false;
    if (raw.startsWith('{')) {
      try {
        return JSON.parse(raw).token === token;
      } catch {
        return false;
      }
    }
    return raw === token;
  }

  return {
    status: 'ready',
    published,
    async zadd(key, ...args) {
      let nx = false;
      let xx = false;
      while (args.length > 2 && typeof args[0] === 'string') {
        const opt = args.shift().toUpperCase();
        if (opt === 'NX') nx = true;
        else if (opt === 'XX') xx = true;
      }
      const [score, member] = args;
      let m = zsets.get(key);
      if (!m) {
        m = new Map();
        zsets.set(key, m);
      }
      const exists = m.has(member);
      if (nx && exists) return 0;
      if (xx && !exists) return 0;
      m.set(member, Number(score));
      return exists ? 0 : 1;
    },
    async zscore(key, member) {
      const v = zsets.get(key)?.get(member);
      return v === undefined ? null : String(v);
    },
    async zrevrange(key, start, stop, withscores) {
      const m = zsets.get(key);
      if (!m) return [];
      const order = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
      const slice = order.slice(start, stop + 1);
      if (String(withscores).toUpperCase() === 'WITHSCORES') {
        return slice.flatMap(([member, score]) => [member, String(score)]);
      }
      return slice.map(([member]) => member);
    },
    async zcard(key) {
      return zsets.get(key)?.size ?? 0;
    },
    async zrem(key, member) {
      const m = zsets.get(key);
      if (!m || !m.has(member)) return 0;
      m.delete(member);
      return 1;
    },
    async set(key, value, ...args) {
      let nx = false;
      let px = null;
      for (let i = 0; i < args.length; i++) {
        const a = String(args[i]).toUpperCase();
        if (a === 'NX') nx = true;
        else if (a === 'PX') px = Number(args[++i]);
      }
      if (nx && live(key)) return null;
      strings.set(key, { value: String(value), expiresMs: px ? Date.now() + px : null });
      return 'OK';
    },
    async get(key) {
      return live(key)?.value ?? null;
    },
    async exists(key) {
      return live(key) ? 1 : 0;
    },
    async eval(script, numkeys, ...args) {
      const keys = args.slice(0, numkeys);
      const argv = args.slice(numkeys);
      const key = keys[0];
      const e = live(key);
      if (script.includes('PEXPIRE')) {
        const [token, ttl] = argv;
        if (!e || !compareToken(e.value, token)) return 0;
        e.expiresMs = Date.now() + Number(ttl);
        return 1;
      }
      const [token] = argv;
      if (!e || !compareToken(e.value, token)) return 0;
      strings.delete(key);
      return 1;
    },
    async publish(channel, message) {
      published.push({ channel, message });
      return 1;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  void stopHeartbeat;
});

describe('RF-7 verification queue (ZSET)', () => {
  it('adds, avoids duplicates, orders by priority and reports size', async () => {
    const redis = fakeVerificationRedis();
    expect(await enqueueTally('E14-176-0042-03', 30, redis)).toBe(true);
    expect(await enqueueTally('E14-201-0007-03', 20, redis)).toBe(true);
    expect(await enqueueTally('E14-033-0115-03', 10, redis)).toBe(true);
    expect(await enqueueTally('E14-176-0042-03', 99, redis)).toBe(false);
    expect(await getTally('E14-176-0042-03', redis)).toEqual({
      tally: 'E14-176-0042-03',
      priority: 30,
    });
    const list = await pending(10, 0, redis);
    expect(list.map((c) => c.tally)).toEqual([
      'E14-176-0042-03',
      'E14-201-0007-03',
      'E14-033-0115-03',
    ]);
    expect(await queueSize(redis)).toBe(3);
  });

  it('updates priority and reorders', async () => {
    const redis = fakeVerificationRedis();
    await enqueueTally('A', 10, redis);
    await enqueueTally('B', 20, redis);
    expect(await updatePriority('A', 50, redis)).toBe(true);
    expect(await updatePriority('DOES-NOT-EXIST', 50, redis)).toBe(false);
    const list = await pending(10, 0, redis);
    expect(list[0]).toEqual({ tally: 'A', priority: 50 });
  });

  it('removes and requeues without duplicating', async () => {
    const redis = fakeVerificationRedis();
    await enqueueTally('A', 10, redis);
    expect(await removeTally('A', redis)).toBe(true);
    expect(await removeTally('A', redis)).toBe(false);
    expect(await queueSize(redis)).toBe(0);
    expect(await requeueTally('A', 15, redis)).toBe(true);
    expect(await getTally('A', redis)).toEqual({ tally: 'A', priority: 15 });
    expect(await queueSize(redis)).toBe(1);
  });
});

describe('RF-7 distributed locks (SET NX PX + Lua)', () => {
  it('two auditors try to take the same tally: only one gets the lock', async () => {
    const redis = fakeVerificationRedis();
    await enqueueTally('E14-176-0042-03', 30, redis);
    const a = await tryLock('E14-176-0042-03', 'AUD-1', 30_000, redis);
    const b = await tryLock('E14-176-0042-03', 'AUD-2', 30_000, redis);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(await lockOwner('E14-176-0042-03', redis)).toMatchObject({
      auditor: 'AUD-1',
    });
  });

  it("an auditor cannot release another auditor's lock", async () => {
    const redis = fakeVerificationRedis();
    const a = await tryLock('TALLY-1', 'AUD-1', 30_000, redis);
    expect(await releaseLock('TALLY-1', 'fake-token', redis)).toBe(false);
    expect(await lockOwner('TALLY-1', redis)).toMatchObject({ auditor: 'AUD-1' });
    expect(await releaseLock('TALLY-1', a.token, redis)).toBe(true);
    expect(await lockOwner('TALLY-1', redis)).toBeNull();
  });

  it('renews the TTL and detects expiration', async () => {
    const redis = fakeVerificationRedis();
    const a = await tryLock('TALLY-1', 'AUD-1', 200, redis);
    expect(await renewLock('TALLY-1', a.token, 1000, redis)).toBe(true);
    expect(await renewLock('TALLY-1', 'other', 1000, redis)).toBe(false);
    const short = await tryLock('TALLY-2', 'AUD-1', 80, redis);
    expect(short).not.toBeNull();
    await sleep(120);
    const b = await tryLock('TALLY-2', 'AUD-2', 30_000, redis);
    expect(b).not.toBeNull();
  });

  it('A cannot release the lock reassigned to B (expiration scenario)', async () => {
    const redis = fakeVerificationRedis();
    const a = await tryLock('TALLY-1', 'AUD-A', 80, redis);
    await sleep(120);
    const b = await tryLock('TALLY-1', 'AUD-B', 30_000, redis);
    expect(b).not.toBeNull();
    expect(await releaseLock('TALLY-1', a.token, redis)).toBe(false);
    expect(await lockOwner('TALLY-1', redis)).toMatchObject({ auditor: 'AUD-B' });
  });
});

describe('RF-7 heartbeat', () => {
  it('keeps the lock alive while working and stops when asked', async () => {
    const redis = fakeVerificationRedis();
    const { token } = await tryLock('TALLY-1', 'AUD-1', 200, redis);
    const ctrl = startHeartbeat('TALLY-1', token, {
      ttlMs: 200,
      intervalMs: 50,
      redis,
    });
    await sleep(350);
    expect(await lockOwner('TALLY-1', redis)).toMatchObject({ auditor: 'AUD-1' });
    ctrl.stop();
    await sleep(250);
    expect(await lockOwner('TALLY-1', redis)).toBeNull();
  });

  it('stops by itself if the token no longer owns the lock and notifies', async () => {
    const redis = fakeVerificationRedis();
    let lost = null;
    startHeartbeat('TALLY-1', 'old-token', {
      ttlMs: 200,
      intervalMs: 30,
      redis,
      onLost: (info) => {
        lost = info;
      },
    });
    await sleep(120);
    expect(lost).toMatchObject({ tally: 'TALLY-1', token: 'old-token' });
  });
});

describe('RF-7 takeCase/releaseCase facade (signatures unchanged)', () => {
  it('assigns by priority, publishes events and releases', async () => {
    const redis = fakeVerificationRedis();
    registerClients({ redis, redisSub: redis });
    await enqueueTally('LOW', 10, redis);
    await enqueueTally('HIGH', 90, redis);

    const kase = await takeCase('AUD-7');
    expect(kase).toMatchObject({ tally: 'HIGH' });
    expect(typeof kase.token).toBe('string');
    expect(kase.ttl_ms).toBeGreaterThan(0);

    const queue = await viewQueue();
    expect(queue.find((c) => c.tally === 'HIGH')).toMatchObject({ assigned_to: 'AUD-7' });

    const kase2 = await takeCase('AUD-8');
    expect(kase2).toMatchObject({ tally: 'LOW' });

    expect(await releaseCase('AUD-8', 'HIGH', 'fake')).toBe(false);
    expect(await releaseCase('AUD-7', 'HIGH', kase.token)).toBe(true);
    expect(await resolveCase('AUD-8', 'LOW', kase2.token)).toBe(true);
    expect(await queueSize(redis)).toBe(1);
  });
});

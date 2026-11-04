import { describe, expect, it } from 'vitest';
import { registerClients } from '../redis/client.js';
import {
  active,
  updateTally,
  updateStatus,
  detectGhosts,
  heartbeat,
  get,
  purgeExpired,
  register,
  leave,
} from './tracker.js';
import { presentAuditors } from './index.js';

function fakePresenceRedis() {
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

  function patternToRegex(pattern) {
    return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  }

  return {
    status: 'ready',
    published,
    async set(key, value, ...args) {
      let ex = null;
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === 'EX') ex = Number(args[++i]) * 1000;
      }
      strings.set(key, { value: String(value), expiresMs: ex ? Date.now() + ex : null });
      return 'OK';
    },
    async get(key) {
      return live(key)?.value ?? null;
    },
    async del(key) {
      return strings.delete(key) ? 1 : 0;
    },
    async scan(cursor, ...args) {
      let match = '*';
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === 'MATCH') match = args[++i];
      }
      const rx = patternToRegex(match);
      const all = [...strings.keys()].filter((k) => rx.test(k) && live(k));
      return ['0', all];
    },
    async publish(channel, message) {
      published.push({ channel, message: JSON.parse(message) });
      return 1;
    },
    _ageHeartbeat(auditor, msAgo) {
      const e = live(`presence:${auditor}`);
      if (!e) return false;
      const o = JSON.parse(e.value);
      o.heartbeat = Date.now() - msAgo;
      e.value = JSON.stringify(o);
      return true;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('RF-8 distributed presence', () => {
  it('registers, renews heartbeat and queries', async () => {
    const redis = fakePresenceRedis();
    const r1 = await register('AUD-1', { instance: 'inst-1' }, redis);
    expect(r1).toMatchObject({ auditor: 'AUD-1', status: 'online', instance: 'inst-1' });
    expect(await get('AUD-1', redis)).toMatchObject({ auditor: 'AUD-1' });
    await sleep(5);
    const r2 = await heartbeat('AUD-1', { instance: 'inst-1', current_tally: 'E14-1' }, redis);
    expect(r2.since).toBe(r1.since);
    expect(r2.current_tally).toBe('E14-1');
  });

  it('an auditor connected to instance 1 is visible from instance 8', async () => {
    const redis = fakePresenceRedis();
    await register('AUD-1', { instance: 'inst-1' }, redis);
    await register('AUD-2', { instance: 'inst-8' }, redis);
    const list = await active(redis);
    expect(list.map((r) => r.auditor).sort()).toEqual(['AUD-1', 'AUD-2']);
    expect(list.find((r) => r.auditor === 'AUD-1')).toMatchObject({ instance: 'inst-1' });
  });

  it('updates status and assigned tally', async () => {
    const redis = fakePresenceRedis();
    await register('AUD-1', { instance: 'i1' }, redis);
    expect(await updateTally('AUD-1', 'E14-9', redis)).toMatchObject({ current_tally: 'E14-9' });
    expect(await updateStatus('AUD-1', 'online', redis)).toMatchObject({ status: 'online' });
    expect(await updateTally('AUD-X', 'E14-1', redis)).toBeNull();
  });

  it('leave publishes offline and disappears from the listing', async () => {
    const redis = fakePresenceRedis();
    await register('AUD-1', { instance: 'i1' }, redis);
    expect(await leave('AUD-1', redis)).toBe(true);
    expect(await get('AUD-1', redis)).toBeNull();
    expect(await active(redis)).toEqual([]);
    expect(redis.published.some((p) => p.message.status === 'offline')).toBe(true);
    expect(await leave('AUD-1', redis)).toBe(false);
  });

  it('TTL expiration makes the disconnected auditor disappear', async () => {
    const redis = fakePresenceRedis();
    await register('AUD-1', { instance: 'i1', ttlS: 1 }, redis);
    expect(await get('AUD-1', redis)).not.toBeNull();
    await sleep(1100);
    expect(await get('AUD-1', redis)).toBeNull();
    expect(await active(redis)).toEqual([]);
  });

  it('detects ghosts and purges them with an offline event', async () => {
    const redis = fakePresenceRedis();
    await register('AUD-1', { instance: 'i1', ttlS: 300 }, redis);
    await register('AUD-2', { instance: 'i2', ttlS: 300 }, redis);
    redis._ageHeartbeat('AUD-1', 120_000);
    const ghosts = await detectGhosts(60_000, redis);
    expect(ghosts.map((f) => f.auditor)).toEqual(['AUD-1']);
    const purged = await purgeExpired(60_000, redis);
    expect(purged.map((f) => f.auditor)).toEqual(['AUD-1']);
    expect(await get('AUD-1', redis)).toBeNull();
    expect(await get('AUD-2', redis)).not.toBeNull();
  });

  it('presentAuditors() facade sees the global view when Redis is available', async () => {
    const redis = fakePresenceRedis();
    registerClients({ redis, redisSub: redis });
    await register('AUD-9', { instance: 'inst-3' }, redis);
    const list = await presentAuditors();
    expect(list.map((r) => r.auditor)).toContain('AUD-9');
  });
});

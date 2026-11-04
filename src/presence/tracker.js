import { CHANNELS } from '../contracts/channels.js';
import { presence as presenceKey } from '../contracts/keys.js';
import { getRedis } from '../redis/client.js';

export const PRESENCE_TTL_S = 45;

export const GHOST_THRESHOLD_MS = 60_000;

function client(explicitRedis) {
  const r = explicitRedis ?? getRedis();
  if (!r) throw new Error('Redis unavailable: presence requires Redis');
  return r;
}

function validateAuditor(auditor) {
  if (typeof auditor !== 'string' || auditor.trim() === '') {
    throw new Error('auditor must be a non-empty string');
  }
}

function now() {
  return Date.now();
}

function parse(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o.auditor !== 'string') return null;
    return {
      auditor: o.auditor,
      status: o.status === 'offline' ? 'offline' : 'online',
      instance: typeof o.instance === 'string' ? o.instance : 'unknown',
      current_tally:
        typeof o.current_tally === 'string' || o.current_tally === null
          ? (o.current_tally ?? null)
          : null,
      since: Number(o.since) || now(),
      heartbeat: Number(o.heartbeat) || Number(o.since) || now(),
    };
  } catch {
    return null;
  }
}

async function publish(redis, event) {
  try {
    if (!redis || typeof redis.publish !== 'function') return;
    if (redis.status && redis.status !== 'ready') return;
    await redis.publish(CHANNELS.PRESENCE, JSON.stringify(event));
  } catch {
    return;
  }
}

async function readRecord(redis, auditor) {
  const raw = await redis.get(presenceKey(auditor));
  return parse(raw);
}

async function listKeys(redis) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'presence:*', 'COUNT', 100);
    cursor = String(next);
    for (const k of batch) keys.push(k);
  } while (cursor !== '0');
  return keys;
}

export async function register(auditor, options = {}, explicitRedis) {
  validateAuditor(auditor);
  const {
    instance = 'unknown',
    status = 'online',
    current_tally = null,
    ttlS = PRESENCE_TTL_S,
  } = options;
  const redis = client(explicitRedis ?? options.redis);
  const ttl = Number(ttlS) || PRESENCE_TTL_S;
  try {
    const previous = await readRecord(redis, auditor);
    const record = {
      auditor,
      status,
      instance,
      current_tally: current_tally ?? previous?.current_tally ?? null,
      since: previous?.since ?? now(),
      heartbeat: now(),
    };
    await redis.set(presenceKey(auditor), JSON.stringify(record), 'EX', ttl);
    if (!previous || previous.status === 'offline') {
      await publish(redis, {
        auditor,
        status: 'online',
        instance,
        current_tally: record.current_tally,
        since: record.since,
      });
    }
    return record;
  } catch (err) {
    throw new Error(`register(${auditor}) failed: ${err.message}`, { cause: err });
  }
}

export async function heartbeat(auditor, options = {}, explicitRedis) {
  return register(auditor, options, explicitRedis ?? options.redis);
}

export async function get(auditor, explicitRedis) {
  validateAuditor(auditor);
  const redis = client(explicitRedis);
  try {
    return await readRecord(redis, auditor);
  } catch (err) {
    throw new Error(`get(${auditor}) failed: ${err.message}`, { cause: err });
  }
}

export async function active(explicitRedis) {
  const redis = client(explicitRedis);
  try {
    const keys = await listKeys(redis);
    if (keys.length === 0) return [];
    const values = await Promise.all(keys.map((k) => redis.get(k).catch(() => null)));
    return values.map(parse).filter(Boolean);
  } catch (err) {
    throw new Error(`active() failed: ${err.message}`, { cause: err });
  }
}

export async function updateStatus(auditor, status, explicitRedis) {
  validateAuditor(auditor);
  if (status !== 'online' && status !== 'offline') throw new Error('status must be online|offline');
  const redis = client(explicitRedis);
  try {
    const previous = await readRecord(redis, auditor);
    if (!previous) return null;
    const record = { ...previous, status, heartbeat: now() };
    await redis.set(presenceKey(auditor), JSON.stringify(record), 'EX', PRESENCE_TTL_S);
    await publish(redis, {
      auditor,
      status,
      instance: record.instance,
      current_tally: record.current_tally,
      since: record.since,
    });
    return record;
  } catch (err) {
    throw new Error(`updateStatus(${auditor}) failed: ${err.message}`, { cause: err });
  }
}

export async function updateTally(auditor, current_tally, explicitRedis) {
  validateAuditor(auditor);
  const redis = client(explicitRedis);
  try {
    const previous = await readRecord(redis, auditor);
    if (!previous) return null;
    const record = { ...previous, current_tally: current_tally ?? null, heartbeat: now() };
    await redis.set(presenceKey(auditor), JSON.stringify(record), 'EX', PRESENCE_TTL_S);
    return record;
  } catch (err) {
    throw new Error(`updateTally(${auditor}) failed: ${err.message}`, { cause: err });
  }
}

export async function leave(auditor, explicitRedis) {
  validateAuditor(auditor);
  const redis = client(explicitRedis);
  try {
    const previous = await readRecord(redis, auditor);
    if (typeof redis.del === 'function') {
      await redis.del(presenceKey(auditor));
    } else if (typeof redis.unlink === 'function') {
      await redis.unlink(presenceKey(auditor));
    }
    if (previous) {
      await publish(redis, {
        auditor,
        status: 'offline',
        instance: previous.instance,
        since: previous.since,
      });
      return true;
    }
    return false;
  } catch (err) {
    throw new Error(`leave(${auditor}) failed: ${err.message}`, { cause: err });
  }
}

export async function detectGhosts(thresholdMs = GHOST_THRESHOLD_MS, explicitRedis) {
  const redis = client(explicitRedis);
  const threshold = Number(thresholdMs) || GHOST_THRESHOLD_MS;
  const list = await active(redis);
  const t = now();
  return list.filter((r) => t - Number(r.heartbeat) > threshold);
}

export async function purgeExpired(thresholdMs = GHOST_THRESHOLD_MS, explicitRedis) {
  const redis = client(explicitRedis);
  const ghosts = await detectGhosts(thresholdMs, redis);
  for (const g of ghosts) {
    try {
      if (typeof redis.del === 'function') await redis.del(presenceKey(g.auditor));
      await publish(redis, {
        auditor: g.auditor,
        status: 'offline',
        instance: g.instance,
        since: g.since,
      });
    } catch {
      continue;
    }
  }
  return ghosts;
}

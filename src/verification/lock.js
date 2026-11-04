import { randomUUID } from 'node:crypto';
import { tallyLock } from '../contracts/keys.js';
import { getRedis } from '../redis/client.js';

export const LOCK_TTL_MS = 30_000;

export const LUA_RELEASE = `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local ok = false
if string.sub(v, 1, 1) == '{' then
  local o = cjson.decode(v)
  if o and o.token == ARGV[1] then ok = true end
else
  if v == ARGV[1] then ok = true end
end
if ok then return redis.call('DEL', KEYS[1]) else return 0 end
`;

export const LUA_RENEW = `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local ok = false
if string.sub(v, 1, 1) == '{' then
  local o = cjson.decode(v)
  if o and o.token == ARGV[1] then ok = true end
else
  if v == ARGV[1] then ok = true end
end
if not ok then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;

function client(explicitRedis) {
  const r = explicitRedis ?? getRedis();
  if (!r) throw new Error('Redis unavailable: locks require Redis');
  return r;
}

function validate(map) {
  for (const [name, value] of Object.entries(map)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${name} must be a non-empty string`);
    }
  }
}

function parseValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o.token === 'string') {
        return { auditor: typeof o.auditor === 'string' ? o.auditor : null, token: o.token };
      }
    } catch {
      return null;
    }
  }
  return { auditor: null, token: String(raw) };
}

export async function tryLock(tally, auditor, ttlMs = LOCK_TTL_MS, explicitRedis) {
  validate({ tally, auditor });
  const ttl = Number(ttlMs) || LOCK_TTL_MS;
  if (ttl <= 0) throw new Error('ttlMs must be positive');
  const redis = client(explicitRedis);
  const token = randomUUID();
  const value = JSON.stringify({ auditor, token });
  try {
    const res = await redis.set(tallyLock(tally), value, 'PX', ttl, 'NX');
    if (res !== 'OK') return null;
    return { token, ttl_ms: ttl };
  } catch (err) {
    throw new Error(`tryLock(${tally}) failed: ${err.message}`, { cause: err });
  }
}

export async function lockOwner(tally, explicitRedis) {
  validate({ tally });
  const redis = client(explicitRedis);
  try {
    return parseValue(await redis.get(tallyLock(tally)));
  } catch (err) {
    throw new Error(`lockOwner(${tally}) failed: ${err.message}`, { cause: err });
  }
}

export async function activeLock(tally, explicitRedis) {
  validate({ tally });
  const redis = client(explicitRedis);
  try {
    if (typeof redis.exists === 'function') {
      return Number(await redis.exists(tallyLock(tally))) === 1;
    }
    return (await redis.get(tallyLock(tally))) !== null;
  } catch (err) {
    throw new Error(`activeLock(${tally}) failed: ${err.message}`, { cause: err });
  }
}

export async function releaseLock(tally, token, explicitRedis) {
  validate({ tally, token });
  const redis = client(explicitRedis);
  try {
    const res = await redis.eval(LUA_RELEASE, 1, tallyLock(tally), token);
    return Number(res) === 1;
  } catch (err) {
    throw new Error(`releaseLock(${tally}) failed: ${err.message}`, { cause: err });
  }
}

export async function renewLock(tally, token, ttlMs = LOCK_TTL_MS, explicitRedis) {
  validate({ tally, token });
  const ttl = Number(ttlMs) || LOCK_TTL_MS;
  if (ttl <= 0) throw new Error('ttlMs must be positive');
  const redis = client(explicitRedis);
  try {
    const res = await redis.eval(LUA_RENEW, 1, tallyLock(tally), token, String(ttl));
    return Number(res) === 1;
  } catch (err) {
    throw new Error(`renewLock(${tally}) failed: ${err.message}`, { cause: err });
  }
}

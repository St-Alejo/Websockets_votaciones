import { verificationQueue } from '../contracts/keys.js';
import { getRedis } from '../redis/client.js';

function client(explicitRedis) {
  const r = explicitRedis ?? getRedis();
  if (!r) throw new Error('Redis unavailable: verification queue requires Redis');
  return r;
}

function validateTally(tally) {
  if (typeof tally !== 'string' || tally.trim() === '') {
    throw new Error('tally must be a non-empty string');
  }
}

function validatePriority(priority) {
  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    throw new Error('priority must be a finite number');
  }
}

export async function enqueueTally(tally, priority, explicitRedis) {
  validateTally(tally);
  validatePriority(priority);
  const redis = client(explicitRedis);
  try {
    const added = await redis.zadd(verificationQueue, 'NX', priority, tally);
    return Number(added) === 1;
  } catch (err) {
    throw new Error(`enqueueTally(${tally}) failed: ${err.message}`, { cause: err });
  }
}

export async function updatePriority(tally, priority, explicitRedis) {
  validateTally(tally);
  validatePriority(priority);
  const redis = client(explicitRedis);
  try {
    const exists = await redis.zscore(verificationQueue, tally);
    if (exists === null) return false;
    await redis.zadd(verificationQueue, 'XX', priority, tally);
    return true;
  } catch (err) {
    throw new Error(`updatePriority(${tally}) failed: ${err.message}`, { cause: err });
  }
}

export async function getTally(tally, explicitRedis) {
  validateTally(tally);
  const redis = client(explicitRedis);
  try {
    const score = await redis.zscore(verificationQueue, tally);
    if (score === null) return null;
    return { tally, priority: Number(score) };
  } catch (err) {
    throw new Error(`getTally(${tally}) failed: ${err.message}`, { cause: err });
  }
}

export async function pending(limit = 100, offset = 0, explicitRedis) {
  const redis = client(explicitRedis);
  const lim = Math.max(1, Math.min(Number(limit) || 100, 1000));
  const off = Math.max(0, Number(offset) || 0);
  try {
    const raw = await redis.zrevrange(verificationQueue, off, off + lim - 1, 'WITHSCORES');
    const list = [];
    for (let i = 0; i < raw.length; i += 2) {
      list.push({ tally: raw[i], priority: Number(raw[i + 1]) });
    }
    return list;
  } catch (err) {
    throw new Error(`pending() failed: ${err.message}`, { cause: err });
  }
}

export async function queueSize(explicitRedis) {
  const redis = client(explicitRedis);
  try {
    return Number(await redis.zcard(verificationQueue));
  } catch (err) {
    throw new Error(`queueSize() failed: ${err.message}`, { cause: err });
  }
}

export async function removeTally(tally, explicitRedis) {
  validateTally(tally);
  const redis = client(explicitRedis);
  try {
    return Number(await redis.zrem(verificationQueue, tally)) === 1;
  } catch (err) {
    throw new Error(`removeTally(${tally}) failed: ${err.message}`, { cause: err });
  }
}

export async function requeueTally(tally, priority, explicitRedis) {
  validateTally(tally);
  validatePriority(priority);
  const redis = client(explicitRedis);
  try {
    await redis.zadd(verificationQueue, priority, tally);
    return true;
  } catch (err) {
    throw new Error(`requeueTally(${tally}) failed: ${err.message}`, { cause: err });
  }
}

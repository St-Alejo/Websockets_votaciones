import { CHANNELS } from '../contracts/channels.js';
import { getRedis } from '../redis/client.js';
import {
  updatePriority,
  enqueueTally,
  getTally,
  pending,
  requeueTally,
  removeTally,
  queueSize,
} from './queue.js';
import { lockOwner, tryLock, releaseLock, LOCK_TTL_MS } from './lock.js';

async function publish(event) {
  try {
    const redis = getRedis();
    if (!redis || typeof redis.publish !== 'function') return;
    if (redis.status && redis.status !== 'ready') return;
    await redis.publish(CHANNELS.VERIFICATION, JSON.stringify(event));
  } catch {
    return;
  }
}

export async function takeCase(auditor) {
  if (typeof auditor !== 'string' || auditor === '') {
    throw new Error('auditor must be a non-empty string');
  }
  const candidates = await pending(50, 0);
  for (const c of candidates) {
    const r = await tryLock(c.tally, auditor, LOCK_TTL_MS);
    if (r) {
      await publish({ type: 'assigned', tally: c.tally, auditor });
      return { tally: c.tally, token: r.token, ttl_ms: r.ttl_ms };
    }
  }
  return null;
}

export async function releaseCase(auditor, tally, token) {
  if (typeof auditor !== 'string' || auditor === '') {
    throw new Error('auditor must be a non-empty string');
  }
  const ok = await releaseLock(tally, token);
  if (ok) await publish({ type: 'released', tally, auditor });
  return ok;
}

export async function viewQueue() {
  const list = await pending(200, 0);
  const rows = await Promise.all(
    list.map(async (c) => {
      try {
        const owner = await lockOwner(c.tally);
        return { ...c, assigned_to: owner?.auditor ?? (owner ? 'unknown' : null) };
      } catch {
        return { ...c, assigned_to: null };
      }
    }),
  );
  return rows;
}

export async function enqueueForVerification(tally, priority) {
  const added = await enqueueTally(tally, priority);
  if (added) await publish({ type: 'queued', tally });
  return added;
}

export async function resolveCase(auditor, tally, token) {
  const ok = await releaseLock(tally, token);
  if (!ok) return false;
  await removeTally(tally);
  await publish({ type: 'resolved', tally, auditor });
  return true;
}

export { updatePriority, getTally, requeueTally, removeTally, queueSize, LOCK_TTL_MS };

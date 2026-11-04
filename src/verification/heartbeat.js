import { renewLock, LOCK_TTL_MS } from './lock.js';
import { getRedis } from '../redis/client.js';

const active = new Map();

function key(tally, token) {
  return `${tally}:${token}`;
}

export function startHeartbeat(tally, token, options = {}) {
  if (typeof tally !== 'string' || tally === '') throw new Error('tally required');
  if (typeof token !== 'string' || token === '') throw new Error('token required');
  const {
    ttlMs = LOCK_TTL_MS,
    intervalMs = Math.floor(Number(ttlMs) / 3),
    redis: explicitRedis,
    onLost,
    onError,
  } = options;
  const ttl = Number(ttlMs) || LOCK_TTL_MS;
  const interval = Number(intervalMs) || Math.floor(ttl / 3);
  if (interval >= ttl) {
    throw new Error(`intervalMs (${interval}) must be less than ttlMs (${ttl})`);
  }

  const k = key(tally, token);
  const previous = active.get(k);
  if (previous) return previous;

  let stopped = false;
  let timer = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (active.get(k)?.control === control) active.delete(k);
  };

  const control = { stop, tally };
  active.set(k, { control, timer: null });

  timer = setInterval(async () => {
    if (stopped) return;
    try {
      const redis = explicitRedis ?? getRedis();
      const ok = await renewLock(tally, token, ttl, redis);
      if (!ok) {
        stop();
        if (typeof onLost === 'function') {
          try {
            onLost({ tally, token });
          } catch {
            return;
          }
        }
      }
    } catch (err) {
      if (typeof onError === 'function') {
        try {
          onError(err);
        } catch {
          return;
        }
      }
    }
  }, interval);
  if (typeof timer.unref === 'function') timer.unref();
  active.get(k).timer = timer;

  return control;
}

export function stopHeartbeat(tally, token) {
  const k = key(tally, token);
  const entry = active.get(k);
  if (!entry) return false;
  entry.control.stop();
  return true;
}

export function _active() {
  return active.size;
}

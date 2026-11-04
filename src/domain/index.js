import { topic as toTopic } from '../contracts/channels.js';
import { getRedis } from '../redis/client.js';
import { applyVerified, register } from '../redis/tallies.js';
import { readRanking, readSnapshot } from '../redis/totals.js';
import { readSince } from '../redis/history.js';
import { consume } from '../redis/rateLimit.js';

export { RateLimitError, RedisUnavailableError } from './errors.js';

const CONFIG = Symbol.for('preconteo.domain.config');

export function configureDomain(config) {
  globalThis[CONFIG] = config;
}

export const currentConfig = () => globalThis[CONFIG] ?? null;

export async function registerTally(tally) {
  const c = currentConfig() ?? {};
  const redis = getRedis();
  return register(redis, tally, {
    instance: c.instanceId,
    streamMaxlen: c.streamMaxlen,
    beforeRegister: c.rlMax
      ? (valid) => consume(redis, valid.juror, { max: c.rlMax, windowMs: c.rlWindowMs })
      : undefined,
  });
}

export async function applyVerifiedTally(tally, version) {
  return applyVerified(getRedis(), tally, version, {
    streamMaxlen: currentConfig()?.streamMaxlen,
  });
}

export async function readTotals(level, id) {
  const t = toTopic(level, id);
  const { levels } = await readSnapshot(getRedis(), [t]);
  return levels[t];
}

export async function ranking(level, id, topN) {
  return readRanking(getRedis(), level, id, topN);
}

export async function snapshot(levels) {
  return readSnapshot(getRedis(), levels);
}

export async function readHistorySince(streamId, max) {
  return readSince(getRedis(), streamId, max);
}

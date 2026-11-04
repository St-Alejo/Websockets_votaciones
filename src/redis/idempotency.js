import { createHash } from 'node:crypto';
import { TTL_IDEM_S, idem } from '../contracts/keys.js';

export { TTL_IDEM_S };

export function contentHash(tally) {
  const votes = Object.keys(tally.votes)
    .sort()
    .map((k) => [k, tally.votes[k]]);
  const canonical = JSON.stringify([
    tally.municipality,
    tally.station,
    tally.table,
    votes,
    tally.voters,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export async function readIdem(redis, key) {
  const raw = await redis.get(idem(key));
  return raw ? JSON.parse(raw).r : null;
}

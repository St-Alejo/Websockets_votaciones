import * as K from '../contracts/keys.js';
import { parseTopic } from '../contracts/channels.js';
import { translateRedisError } from '../domain/errors.js';

const INTERNAL_FIELDS = new Set(['reported', 'voters']);

function toObject(flat) {
  const o = {};
  for (let i = 0; i < flat.length; i += 2) o[flat[i]] = Number(flat[i + 1]);
  return o;
}

export function buildTotals(level, id, fields, catalogTotal) {
  const votes = {};
  for (const [k, v] of Object.entries(fields)) if (!INTERNAL_FIELDS.has(k)) votes[k] = v;
  const reported = fields.reported ?? 0;
  const total = level === 'table' ? 1 : Number(catalogTotal ?? 0);
  return {
    level,
    id: level === 'dept' ? null : String(id),
    votes,
    voters: fields.voters ?? 0,
    tables_reported: reported,
    tables_total: total,
    percent_reported: total ? Math.min(100, Math.round((reported / total) * 10_000) / 100) : 0,
  };
}

export async function readSnapshot(redis, topics) {
  const requests = [...new Set(topics)].map((t) => ({ t, ...parseTopic(t) }));
  const keys = requests.flatMap(({ level, id }) => [
    K.total(level, id ?? undefined),
    level === 'table' ? K.catalog('table', id) : K.catalog(level, id ?? undefined),
  ]);
  keys.push(K.tallyStream);

  let raw;
  try {
    raw = await redis.snapshotLua(keys.length, ...keys);
  } catch (err) {
    throw translateRedisError(err);
  }
  const levels = {};
  requests.forEach(({ t, level, id }, i) => {
    levels[t] = buildTotals(level, id, toObject(raw[2 * i]), raw[2 * i + 1]);
  });
  return { levels, stream_id: raw[raw.length - 1] };
}

export async function readRanking(redis, level, id, topN) {
  const n = Math.max(1, Math.min(Number(topN) || 10, 100));
  try {
    if (level === 'table') {
      const fields = await redis.hgetall(K.total('table', id));
      return Object.entries(fields)
        .filter(([c]) => /^C\d+$/.test(c))
        .map(([candidate, v]) => ({ candidate, votes: Number(v) }))
        .sort((a, b) => b.votes - a.votes || a.candidate.localeCompare(b.candidate))
        .slice(0, n);
    }
    const flat = await redis.zrevrange(K.rank(level, id ?? undefined), 0, n - 1, 'WITHSCORES');
    const rows = [];
    for (let i = 0; i < flat.length; i += 2)
      rows.push({ candidate: flat[i], votes: Number(flat[i + 1]) });
    return rows;
  } catch (err) {
    throw translateRedisError(err);
  }
}

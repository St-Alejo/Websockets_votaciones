import { randomBytes } from 'node:crypto';
import * as K from '../contracts/keys.js';
import { CHANNELS } from '../contracts/channels.js';
import { RegisterResponse } from '../contracts/schemas.js';
import { balances, imbalance, validateTally } from '../domain/validation.js';
import { translateRedisError } from '../domain/errors.js';
import { contentHash, TTL_IDEM_S } from './idempotency.js';

export function tallyKeys({ tally, idem, table, station, municipality }) {
  return [
    K.tally(tally),
    K.tallyVersions(tally),
    K.idem(idem),
    K.total('table', table),
    K.total('station', station),
    K.total('mun', municipality),
    K.total('dept'),
    K.rank('station', station),
    K.rank('mun', municipality),
    K.rank('dept'),
    K.tallyStream,
    K.verificationQueue,
  ];
}

const newReceipt = (instance) =>
  `R-${instance}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

function normalize(r) {
  return RegisterResponse.parse({ ...r, receipt: r.receipt ?? null });
}

async function run(promise) {
  try {
    return JSON.parse(await promise);
  } catch (err) {
    throw translateRedisError(err);
  }
}

export async function register(redis, input, options = {}) {
  const v = validateTally(input);
  if (!v.ok) {
    return normalize({
      status: 'rejected',
      tally: typeof input?.tally === 'string' ? input.tally : '',
      version: Number.isInteger(input?.version) ? input.version : 0,
      reason: v.reason,
    });
  }
  const tally = v.tally;
  if (options.beforeRegister) await options.beforeRegister(tally);

  const data = {
    votes: tally.votes,
    voters: tally.voters,
    table: tally.table,
    station: tally.station,
    municipality: tally.municipality,
    juror: tally.juror,
  };
  const r = await run(
    redis.registerTallyLua(
      ...tallyKeys(tally),
      'register',
      tally.tally,
      tally.version,
      contentHash(tally),
      JSON.stringify(data),
      balances(tally) ? '1' : '0',
      newReceipt(options.instance ?? 'local'),
      Date.now(),
      TTL_IDEM_S,
      options.streamMaxlen ?? 10_000,
      CHANNELS.NEW_TALLY,
      imbalance(tally),
    ),
  );
  return normalize(r);
}

export async function applyVerified(redis, tallyOrId, version, options = {}) {
  const id = typeof tallyOrId === 'string' ? tallyOrId : tallyOrId?.tally;
  if (!id || !Number.isInteger(version) || version < 1) {
    return { applied: false, reason: 'invalid_parameters' };
  }
  let stored;
  try {
    stored = await redis.hget(K.tallyVersions(id), `${version}:data`);
  } catch (err) {
    throw translateRedisError(err);
  }
  if (!stored) return { applied: false, reason: 'version_not_doubtful_or_unknown' };
  const { table, station, municipality } = JSON.parse(stored);

  return run(
    redis.registerTallyLua(
      ...tallyKeys({ tally: id, idem: '-verification-', table, station, municipality }),
      'verify',
      id,
      version,
      '',
      '',
      '',
      '',
      Date.now(),
      TTL_IDEM_S,
      options.streamMaxlen ?? 10_000,
      CHANNELS.NEW_TALLY,
      0,
    ),
  );
}

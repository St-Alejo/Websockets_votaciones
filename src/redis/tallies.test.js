import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { applyVerified, register } from './tallies.js';
import { testClient, hasRedis, urlWithDb } from './test.helper.js';
import { CHANNELS } from '../contracts/channels.js';
import { NewTallyEvent } from '../contracts/schemas.js';
import * as K from '../contracts/keys.js';

const DB = 11;

function tally({
  id = 'E14-001-0001-03',
  table = 1,
  station = 1,
  municipality = 1,
  version = 1,
  votes,
  extra = 0,
  idem,
}) {
  const v = { C1: 0, C2: 0, C3: 0, BLANK: 0, NULL: 0, UNMARKED: 0, ...votes };
  const sum = Object.values(v).reduce((a, b) => a + b, 0);
  return {
    tally: id,
    table,
    station,
    municipality,
    version,
    juror: 'JUR-1',
    closed_at: 1793577600,
    votes: v,
    voters: sum + extra,
    photo_hash: 'f',
    idem: idem ?? `${id}-v${version}-${extra}`,
  };
}

async function state(redis) {
  const keys = (await redis.keys('total:*')).concat(await redis.keys('rank:*')).sort();
  const out = {};
  for (const k of keys) {
    out[k] = k.startsWith('total:')
      ? await redis.hgetall(k)
      : await redis.zrange(k, 0, -1, 'WITHSCORES');
  }
  for (const k of (await redis.keys('tally:*')).filter((x) => !x.endsWith(':versions')).sort()) {
    out[k] = await redis.hmget(
      k,
      'applied_version',
      'votes',
      'voters',
      'status',
      'doubtful_version',
    );
  }
  out.queue = await redis.zrange(K.verificationQueue, 0, -1, 'WITHSCORES');
  return out;
}

function* permutations(arr) {
  if (arr.length <= 1) return yield arr.slice();
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

describe.skipIf(!(await hasRedis()))('tally registration (real Redis)', () => {
  let redis;
  beforeAll(async () => {
    redis = await testClient(DB);
  });
  beforeEach(() => redis.flushdb());
  afterAll(() => redis?.quit());

  it('registers, adds to all 4 levels and the rankings, and leaves a trace in the stream', async () => {
    const r = await register(redis, tally({ votes: { C1: 10, C2: 5, NULL: 1 } }));
    expect(r).toMatchObject({ status: 'registered', version: 1, current_version: 1 });
    expect(r.receipt).toMatch(/^R-/);
    for (const k of [
      K.total('table', 1),
      K.total('station', 1),
      K.total('mun', 1),
      K.total('dept'),
    ]) {
      expect(await redis.hmget(k, 'C1', 'C2', 'NULL', 'voters', 'reported')).toEqual([
        '10',
        '5',
        '1',
        '16',
        '1',
      ]);
    }
    expect(await redis.zrevrange(K.rank('dept'), 0, -1, 'WITHSCORES')).toEqual([
      'C1',
      '10',
      'C2',
      '5',
      'C3',
      '0',
    ]);
    const [[, fields]] = await redis.xrange(K.tallyStream, '-', '+');
    expect(JSON.parse(fields[1])).toMatchObject({
      tally: 'E14-001-0001-03',
      type: 'new',
      version: 1,
    });
  });

  it('publishes a valid NewTallyEvent on tally:new', async () => {
    const sub = new Redis(urlWithDb(DB));
    await sub.subscribe(CHANNELS.NEW_TALLY);
    const ID = 'E14-990-9901-03';
    const arrival = new Promise((resolve) =>
      sub.on('message', (_c, m) => {
        const e = JSON.parse(m);
        if (e.tally === ID) resolve(e);
      }),
    );
    await register(redis, tally({ id: ID, table: 9901, station: 990, votes: { C1: 1 } }));
    const event = NewTallyEvent.parse(await arrival);
    expect(event).toMatchObject({ tally: ID, mun: 1, station: 990, version: 1, type: 'new' });
    await sub.quit();
  });

  it('the same tally sent 5 times in parallel by 5 different clients is added only once', async () => {
    const clients = await Promise.all(Array.from({ length: 5 }, () => testClient(DB)));
    const a = tally({ votes: { C1: 100, C2: 50 } });
    const responses = await Promise.all(clients.map((c) => register(c, a)));

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'registered']);
    const receipt = responses.find((r) => r.status === 'registered').receipt;
    expect(responses.every((r) => r.receipt === receipt)).toBe(true);
    expect(await redis.hmget(K.total('dept'), 'C1', 'reported')).toEqual(['100', '1']);
    expect(await redis.xlen(K.tallyStream)).toBe(1);
    await Promise.all(clients.map((c) => c.quit()));
  });

  it('convergence: all 720 arrival permutations yield exactly the same totals', async () => {
    const A = { id: 'E14-001-0001-03', table: 1, station: 1, municipality: 1 };
    const B = { id: 'E14-002-0002-03', table: 2, station: 2, municipality: 1 };
    const messages = [
      tally({ ...A, version: 1, votes: { C1: 10, C2: 20 } }),
      tally({ ...A, version: 2, votes: { C1: 15, C2: 18, BLANK: 2 } }),
      tally({ ...A, version: 3, votes: { C1: 16, C2: 18, C3: 1, BLANK: 2 } }),
      tally({ ...B, version: 1, votes: { C1: 7, C2: 3 } }),
      tally({ ...B, version: 2, votes: { C1: 8, C2: 4, NULL: 1 } }),
      tally({ ...B, version: 3, votes: { C1: 99 }, extra: 5 }),
    ];

    let reference;
    let n = 0;
    for (const order of permutations(messages)) {
      await redis.flushdb();
      for (const m of order) await register(redis, m);
      const e = await state(redis);
      if (!reference) reference = e;
      else expect(e).toEqual(reference);
      n++;
    }
    expect(n).toBe(720);
    expect(reference[K.total('mun', 1)]).toMatchObject({
      C1: '24',
      C2: '22',
      C3: '1',
      BLANK: '2',
      NULL: '1',
      reported: '2',
      voters: '50',
    });
    expect(reference[K.tally(B.id)][0]).toBe('2');
    expect(reference[K.tally(B.id)][4]).toBe('3');
    expect(reference.queue).toEqual([B.id, '5']);
  }, 60_000);

  it('a correction reverts the previous version; a late old version does not roll back', async () => {
    await register(redis, tally({ version: 1, votes: { C1: 10 } }));
    const v3 = await register(redis, tally({ version: 3, votes: { C1: 30 } }));
    expect(v3.status).toBe('registered');
    const v2 = await register(redis, tally({ version: 2, votes: { C1: 20 } }));
    expect(v2).toMatchObject({ status: 'stale_version', current_version: 3 });
    expect(await redis.hmget(K.total('dept'), 'C1', 'reported')).toEqual(['30', '1']);
    const types = (await redis.xrange(K.tallyStream, '-', '+')).map(
      ([, c]) => JSON.parse(c[1]).type,
    );
    expect(types).toEqual(['new', 'correction']);
  });

  it('same version with different content -> conflict, no changes', async () => {
    await register(redis, tally({ votes: { C1: 10 } }));
    const r = await register(redis, tally({ votes: { C1: 11 }, idem: 'other-idem-123' }));
    expect(r).toMatchObject({ status: 'conflict', receipt: null, current_version: 1 });
    expect(await redis.hget(K.total('dept'), 'C1')).toBe('10');
  });

  it('an idem reused for another tally -> conflict', async () => {
    await register(redis, tally({ votes: { C1: 1 }, idem: 'shared-idem' }));
    const r = await register(
      redis,
      tally({ id: 'E14-002-0002-03', table: 2, votes: { C1: 1 }, idem: 'shared-idem' }),
    );
    expect(r.status).toBe('conflict');
  });

  it('expired idem: deleting idem:{x} and resending returns duplicate and does not add', async () => {
    const a = tally({ votes: { C1: 40 } });
    const original = await register(redis, a);
    await redis.del(K.idem(a.idem));
    const resend = await register(redis, a);
    expect(resend).toMatchObject({ status: 'duplicate', receipt: original.receipt });
    const otherIdem = await register(redis, { ...a, idem: 'regenerated-idem-1' });
    expect(otherIdem).toMatchObject({ status: 'duplicate', receipt: original.receipt });
    expect(await redis.hget(K.total('dept'), 'C1')).toBe('40');
    expect(await redis.ttl(K.idem(a.idem))).toBeGreaterThan(86_000);
  });

  it('a tally that does not balance -> doubtful, does not add and enters queue:verification', async () => {
    const r = await register(redis, tally({ votes: { C1: 10 }, extra: 3 }));
    expect(r.status).toBe('doubtful');
    expect(r.receipt).toMatch(/^R-/);
    expect(await redis.exists(K.total('dept'), K.total('table', 1))).toBe(0);
    expect(await redis.zscore(K.verificationQueue, 'E14-001-0001-03')).toBe('3');
    expect(await redis.hmget(K.tally('E14-001-0001-03'), 'status', 'doubtful_version')).toEqual([
      'doubtful',
      '1',
    ]);
    expect(await redis.xlen(K.tallyStream)).toBe(0);
  });

  it('applyVerified applies the approved doubtful version and removes it from the queue', async () => {
    await register(redis, tally({ version: 1, votes: { C1: 10 } }));
    await register(redis, tally({ version: 2, votes: { C1: 12 }, extra: 1 }));
    expect(await redis.hget(K.total('dept'), 'C1')).toBe('10');

    const r = await applyVerified(redis, 'E14-001-0001-03', 2);
    expect(r).toMatchObject({ applied: true, current_version: 2 });
    expect(r.stream_id).toMatch(/^\d+-\d+$/);
    expect(await redis.hmget(K.total('dept'), 'C1', 'reported')).toEqual(['12', '1']);
    expect(await redis.zcard(K.verificationQueue)).toBe(0);
    expect(await applyVerified(redis, 'E14-001-0001-03', 2)).toMatchObject({ applied: false });
    expect(await applyVerified(redis, 'E14-001-0001-03', 7)).toMatchObject({ applied: false });
  });

  it('a higher valid version removes a lower doubtful version from the queue', async () => {
    await register(redis, tally({ version: 1, votes: { C1: 10 }, extra: 2 }));
    expect(await redis.zcard(K.verificationQueue)).toBe(1);
    await register(redis, tally({ version: 2, votes: { C1: 11 } }));
    expect(await redis.zcard(K.verificationQueue)).toBe(0);
    expect(await redis.hget(K.tally('E14-001-0001-03'), 'status')).toBe('applied');
  });

  it('invalid JSON -> rejected without touching Redis', async () => {
    const r = await register(redis, { tally: 'x', version: 1 });
    expect(r).toMatchObject({ status: 'rejected', receipt: null });
    expect(await redis.dbsize()).toBe(0);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { register } from './tallies.js';
import { readRanking, readSnapshot } from './totals.js';
import { compareIds, readSince, lastId } from './history.js';
import { testClient, hasRedis } from './test.helper.js';
import { seedCatalog } from '../domain/catalog.js';
import { Totals, Snapshot } from '../contracts/schemas.js';
import * as K from '../contracts/keys.js';

const DB = 12;

function tally(n, { station = 1, municipality = 1, version = 1, c1 = 10, c2 = 5 } = {}) {
  return {
    tally: `E14-${station}-${n}-03`,
    table: n,
    station,
    municipality,
    version,
    juror: `JUR-${n}`,
    closed_at: 1793577600,
    votes: { C1: c1, C2: c2, C3: 1, BLANK: 1, NULL: 0, UNMARKED: 0 },
    voters: c1 + c2 + 2,
    photo_hash: 'f',
    idem: `idem-${n}-v${version}`,
  };
}

describe.skipIf(!(await hasRedis()))('totals, snapshot and history (real Redis)', () => {
  let redis;
  beforeAll(async () => {
    redis = await testClient(DB);
  });
  beforeEach(() => redis.flushdb());
  afterAll(() => redis?.quit());

  it('multi-level snapshot: valid Totals, percent reported and last stream_id', async () => {
    await seedCatalog(redis);
    const total = Number(await redis.get(K.catalog('station', 1)));
    await register(redis, tally(1));
    await register(redis, tally(2, { c1: 3 }));

    const s = Snapshot.parse(await readSnapshot(redis, ['dept', 'mun:1', 'station:1', 'table:1']));
    expect(s.stream_id).toBe(await lastId(redis));
    expect(s.levels.dept).toMatchObject({
      votes: { C1: 13, C2: 10 },
      tables_reported: 2,
      tables_total: 6400,
    });
    expect(s.levels['station:1'].tables_total).toBe(total);
    expect(s.levels['station:1'].percent_reported).toBeCloseTo((2 / total) * 100, 1);
    expect(s.levels['table:1']).toMatchObject({
      voters: 17,
      tables_total: 1,
      percent_reported: 100,
    });
  });

  it('a level with no data returns zeros, not an error', async () => {
    const { levels, stream_id } = await readSnapshot(redis, ['mun:999']);
    expect(Totals.parse(levels['mun:999'])).toMatchObject({
      voters: 0,
      tables_reported: 0,
    });
    expect(stream_id).toBe('0-0');
  });

  it('ranking: sorted top N from the ZSET and from the table HASH', async () => {
    await register(redis, tally(1, { c1: 3, c2: 9 }));
    await register(redis, tally(2, { c1: 4, c2: 1 }));
    expect(await readRanking(redis, 'dept', null, 2)).toEqual([
      { candidate: 'C2', votes: 10 },
      { candidate: 'C1', votes: 7 },
    ]);
    expect(await readRanking(redis, 'table', 1, 1)).toEqual([{ candidate: 'C2', votes: 9 }]);
  });

  it('atomicity: under concurrent writes, no snapshot sees a municipality != sum of its stations', async () => {
    const STATIONS = [1, 2, 3, 4];
    const topics = ['mun:1', ...STATIONS.map((p) => `station:${p}`)];
    const writers = await Promise.all(STATIONS.map(() => testClient(DB)));
    let writing = true;
    let reads = 0;
    const violations = [];

    const reader = (async () => {
      while (writing) {
        const { levels } = await readSnapshot(redis, topics);
        for (const field of ['C1', 'C2', 'C3', 'BLANK']) {
          const sum = STATIONS.reduce((a, p) => a + (levels[`station:${p}`].votes[field] ?? 0), 0);
          if ((levels['mun:1'].votes[field] ?? 0) !== sum) violations.push({ field, reads });
        }
        const rep = STATIONS.reduce((a, p) => a + levels[`station:${p}`].tables_reported, 0);
        if (levels['mun:1'].tables_reported !== rep) violations.push({ field: 'reported', reads });
        reads++;
      }
    })();

    await Promise.all(
      writers.map(async (c, i) => {
        const station = STATIONS[i];
        for (let n = 0; n < 150; n++)
          await register(c, tally(station * 1000 + n, { station, c1: n % 17 }));
        for (let n = 0; n < 30; n++) {
          await register(c, tally(station * 1000 + n, { station, version: 2, c1: 50, c2: n }));
        }
      }),
    );
    writing = false;
    await reader;

    expect(reads).toBeGreaterThan(20);
    expect(violations).toEqual([]);
    const { levels } = await readSnapshot(redis, ['mun:1']);
    expect(levels['mun:1'].tables_reported).toBe(600);
    await Promise.all(writers.map((c) => c.quit()));
  }, 30_000);

  it('history: events after the cursor, in order, with pagination', async () => {
    for (let n = 1; n <= 5; n++) await register(redis, tally(n));
    const all = await readSince(redis, '0-0', 100);
    expect(all.events.map((e) => e.tally)).toEqual([1, 2, 3, 4, 5].map((n) => `E14-1-${n}-03`));
    expect(all.trimmed).toBeUndefined();

    const p1 = await readSince(redis, '0-0', 2);
    expect(p1).toMatchObject({ has_more: true });
    const p2 = await readSince(redis, p1.stream_id, 10);
    expect(p2.events.map((e) => e.table ?? e.tally)).toHaveLength(3);
    expect(compareIds(p2.events[0].stream_id, p1.stream_id)).toBe(1);

    const upToDate = await readSince(redis, all.stream_id, 10);
    expect(upToDate).toMatchObject({ events: [], stream_id: all.stream_id });
  });

  it('history: if the cursor is before the trimmed part, it reports trimmed (request a snapshot)', async () => {
    for (let n = 1; n <= 20; n++) await register(redis, tally(n));
    const [[first]] = await redis.xrange(K.tallyStream, '-', '+', 'COUNT', 1);
    await redis.xtrim(K.tallyStream, 'MAXLEN', 5);
    const r = await readSince(redis, first, 100);
    expect(r.trimmed).toBe(true);
    const recent = await readSince(redis, await lastId(redis), 100);
    expect(recent.trimmed).toBeUndefined();
  });

  it('history: empty stream or invalid cursor', async () => {
    expect(await readSince(redis, '0-0', 10)).toEqual({ events: [], stream_id: '0-0' });
    expect((await readSince(redis, 'garbage', 10)).trimmed).toBe(true);
  });
});

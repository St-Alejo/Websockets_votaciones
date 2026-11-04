import { afterAll, describe, expect, it } from 'vitest';
import { TOTALS, generateCatalog, seedCatalog, catalogTotals } from './catalog.js';
import { testClient, hasRedis } from '../redis/test.helper.js';

describe('synthetic catalog', () => {
  const cat = generateCatalog();

  it('has 40 municipalities, 1,842 stations and 6,400 tables', () => {
    const stations = cat.municipalities.flatMap((m) => m.stations);
    expect(cat.municipalities).toHaveLength(TOTALS.municipalities);
    expect(stations).toHaveLength(TOTALS.stations);
    expect(stations.flatMap((p) => p.tables)).toHaveLength(TOTALS.tables);
    expect(cat.table.size).toBe(TOTALS.tables);
    expect(stations.every((p) => p.tables.length >= 1)).toBe(true);
  });

  it('is deterministic', () => {
    expect(catalogTotals(generateCatalog())).toEqual(catalogTotals(cat));
    expect(catalogTotals(generateCatalog(7))).not.toEqual(catalogTotals(cat));
  });

  it('municipality totals add up their stations and the department', () => {
    const t = Object.fromEntries(catalogTotals(cat));
    let dept = 0;
    for (const m of cat.municipalities) {
      const sum = m.stations.reduce((a, p) => a + t[`cat:station:${p.id}:tables`], 0);
      expect(t[`cat:mun:${m.id}:tables`]).toBe(sum);
      dept += sum;
    }
    expect(t['cat:dept:tables']).toBe(dept);
  });
});

describe.skipIf(!(await hasRedis()))('seed in Redis', () => {
  let redis;
  afterAll(() => redis?.quit());

  it('writes the totals and is idempotent', async () => {
    redis = await testClient(10);
    await redis.flushdb();
    const n = await seedCatalog(redis);
    expect(await seedCatalog(redis)).toBe(n);
    expect(await redis.dbsize()).toBe(n);
    expect(Number(await redis.get('cat:dept:tables'))).toBe(6400);
  });
});

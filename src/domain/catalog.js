import { catalog as catalogKey } from '../contracts/keys.js';

export const TOTALS = Object.freeze({ municipalities: 40, stations: 1842, tables: 6400 });

export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distribute(total, weights, minimum) {
  const free = total - minimum * weights.length;
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((p) => (p / sum) * free);
  const parts = exact.map((x) => minimum + Math.floor(x));
  let missing = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => [x - Math.floor(x), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; missing > 0; k++, missing--) parts[order[k % order.length][1]]++;
  return parts;
}

export function generateCatalog(seed = 2026) {
  const random = prng(seed);
  const munWeights = Array.from({ length: TOTALS.municipalities }, (_, i) => 1 / (i + 1) ** 0.9);
  const stationsPerMun = distribute(TOTALS.stations, munWeights, 3);
  const stationWeights = Array.from(
    { length: TOTALS.stations },
    () => 1 + Math.floor(random() * 10),
  );
  const tablesPerStation = distribute(TOTALS.tables, stationWeights, 1);

  const municipalities = [];
  const table = new Map();
  let stationId = 1;
  let tableId = 1;
  for (let m = 0; m < TOTALS.municipalities; m++) {
    const mun = { id: m + 1, stations: [] };
    for (let p = 0; p < stationsPerMun[m]; p++, stationId++) {
      const station = { id: stationId, tables: [] };
      for (let k = 0; k < tablesPerStation[stationId - 1]; k++, tableId++) {
        station.tables.push(tableId);
        table.set(tableId, { station: station.id, municipality: mun.id });
      }
      mun.stations.push(station);
    }
    municipalities.push(mun);
  }
  return { municipalities, table };
}

export function catalogTotals(cat) {
  const pairs = [[catalogKey('dept'), TOTALS.tables]];
  for (const mun of cat.municipalities) {
    let n = 0;
    for (const station of mun.stations) {
      pairs.push([catalogKey('station', station.id), station.tables.length]);
      n += station.tables.length;
    }
    pairs.push([catalogKey('mun', mun.id), n]);
  }
  return pairs;
}

export async function seedCatalog(redis, seed) {
  const pairs = catalogTotals(generateCatalog(seed));
  await redis.mset(...pairs.flat());
  return pairs.length;
}

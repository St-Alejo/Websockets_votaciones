import { Redis } from 'ioredis';
import { TOTALS, generateCatalog, seedCatalog } from '../src/domain/catalog.js';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const seed = Number(process.env.SEED ?? 2026);

const redis = new Redis(url, { maxRetriesPerRequest: 3 });
try {
  const keys = await seedCatalog(redis, seed);
  const cat = generateCatalog(seed);
  const capital = cat.municipalities[0];
  console.log(
    `[seed-catalog] ${keys} keys in ${url}: ${TOTALS.municipalities} municipalities, ` +
      `${TOTALS.stations} stations, ${TOTALS.tables} tables (seed ${seed}). ` +
      `Capital: municipality ${capital.id} with ${capital.stations.length} stations.`,
  );
} finally {
  await redis.quit();
}

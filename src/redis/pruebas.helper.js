// Dueño: Persona 1. Utilidades para los tests de src/redis contra un Redis REAL (sin mocks).
// Cada archivo de test usa una base distinta (vitest corre archivos en paralelo) y la vacía.
//   REDIS_URL definido   → Redis obligatorio (CI).
//   REDIS_URL sin definir → se intenta redis://localhost:6379; si no responde, se omiten
//                           los tests con un aviso (npm run redis:dev para levantarlo).
import { Redis } from 'ioredis';
import { crearClientesRedis, esperarListo } from './cliente.js';

export const URL_BASE = process.env.REDIS_URL ?? 'redis://localhost:6379';

export function urlConDb(db, url = URL_BASE) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** true si hay un Redis real disponible para los tests. */
export async function hayRedis() {
  if (process.env.REDIS_URL) return true;
  const r = new Redis(URL_BASE, { lazyConnect: true, connectTimeout: 500, retryStrategy: null });
  r.on('error', () => {});
  try {
    await r.connect();
    await r.ping();
    return true;
  } catch {
    console.warn(`[tests] Sin Redis en ${URL_BASE}: se omiten los tests de Persona 1.`);
    return false;
  } finally {
    r.disconnect();
  }
}

/** Cliente de app (con scripts definidos) sobre la base `db`, listo para usar. */
export async function clientePrueba(db, opciones = {}) {
  const { redis, redisSub } = crearClientesRedis(urlConDb(db), opciones);
  redisSub.disconnect();
  redis.on('error', () => {});
  await esperarListo(redis);
  return redis;
}

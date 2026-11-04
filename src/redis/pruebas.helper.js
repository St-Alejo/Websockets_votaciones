// Dueño: Persona 1. Utilidades para los tests de src/redis contra un Redis REAL (sin mocks).
// Cada archivo de test usa una base distinta (vitest corre archivos en paralelo) y la vacía.
//   REDIS_URL definido   → Redis obligatorio (CI).
//   REDIS_URL sin definir → se intenta redis://localhost:6379; si no responde, se omiten
//                           los tests con un aviso (npm run redis:dev para levantarlo).
import net from 'node:net';
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

/**
 * Proxy TCP hacia Redis que se puede "congelar": retiene los bytes en ambas direcciones sin
 * cerrar la conexión, como un Redis colgado. Al descongelar los entrega en orden, así que
 * un comando enviado durante el congelamiento SÍ se ejecuta después (igual que CLIENT PAUSE),
 * pero sin afectar a los demás tests que usan el mismo servidor Redis.
 */
export async function proxyCongelable(destino = URL_BASE) {
  const d = new URL(destino);
  let congelado = false;
  const pendientes = [];
  const pares = new Set();
  const servidor = net.createServer((cliente) => {
    const redis = net.connect(Number(d.port || 6379), d.hostname);
    const par = [cliente, redis];
    pares.add(par);
    const reenviar = (hacia) => (bytes) => {
      if (congelado) pendientes.push(() => hacia.write(bytes));
      else hacia.write(bytes);
    };
    cliente.on('data', reenviar(redis));
    redis.on('data', reenviar(cliente));
    const cerrar = () => {
      pares.delete(par);
      cliente.destroy();
      redis.destroy();
    };
    cliente.on('close', cerrar).on('error', cerrar);
    redis.on('close', cerrar).on('error', cerrar);
  });
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const u = new URL(destino);
  u.hostname = '127.0.0.1';
  u.port = String(servidor.address().port);
  return {
    url: u.toString(),
    congelar() {
      congelado = true;
    },
    descongelar() {
      congelado = false;
      while (pendientes.length) pendientes.shift()();
    },
    async cerrar() {
      for (const [c, r] of pares) {
        c.destroy();
        r.destroy();
      }
      await new Promise((resolve) => servidor.close(resolve));
    },
  };
}

/** Cliente de app (con scripts definidos) sobre la base `db`, listo para usar. */
export async function clientePrueba(db, opciones = {}) {
  const { redis, redisSub } = crearClientesRedis(urlConDb(db), opciones);
  redisSub.disconnect();
  redis.on('error', () => {});
  await esperarListo(redis);
  return redis;
}

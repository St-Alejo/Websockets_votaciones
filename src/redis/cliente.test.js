import { afterAll, describe, expect, it } from 'vitest';
import { crearClientesRedis, estrategiaReintento, redisResponde } from './cliente.js';
import { traducirErrorRedis, ErrorRedisNoDisponible } from '../dominio/errores.js';
import { clientePrueba, hayRedis } from './pruebas.helper.js';

describe('cliente Redis sin servidor', () => {
  // Puerto 1: nadie escucha → conexión rechazada.
  const { redis, redisSub } = crearClientesRedis('redis://127.0.0.1:1', { commandTimeoutMs: 300 });
  redis.on('error', () => {});
  redisSub.on('error', () => {});
  afterAll(() => {
    redis.disconnect();
    redisSub.disconnect();
  });

  it('un comando falla de inmediato (sin cola offline) y se traduce a ErrorRedisNoDisponible', async () => {
    const t0 = performance.now();
    const err = await redis.get('x').catch((e) => e);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(traducirErrorRedis(err)).toBeInstanceOf(ErrorRedisNoDisponible);
  });

  it('redisResponde devuelve false rápido', async () => {
    expect(await redisResponde(redis)).toBe(false);
  });

  it('un bug de programación (TypeError) no se disfraza de 503', () => {
    const bug = new TypeError("Cannot read properties of null (reading 'x')");
    expect(traducirErrorRedis(bug)).toBe(bug);
  });

  it('el backoff está acotado a 2 s', () => {
    for (let i = 1; i < 50; i++) expect(estrategiaReintento(i)).toBeLessThanOrEqual(2000);
  });
});

describe.skipIf(!(await hayRedis()))('cliente Redis con servidor real', () => {
  it('conecta y responde PING', async () => {
    const redis = await clientePrueba(9);
    expect(await redisResponde(redis)).toBe(true);
    await redis.quit();
  });
});

// Endpoints de Persona 1 contra un Redis REAL (base 13). Tests obligatorios 6 y 7.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { construirApp } from '../../server.js';
import { esperarListo } from '../../redis/cliente.js';
import { hayRedis, proxyCongelable, urlConDb } from '../../redis/pruebas.helper.js';

const DB = 13;
const BASE = {
  port: 0,
  host: '127.0.0.1',
  instanceId: 'test-p1',
  logLevel: 'silent',
  redisUrl: urlConDb(DB),
  redisCommandTimeoutMs: 400,
  rlMax: 0, // sin límite salvo en el test de 429
  rlVentanaMs: 60_000,
  streamMaxlen: 10_000,
};

let secuencia = 0;
function acta({ jurado = 'JUR-1', extra = 0, version = 1, mesa } = {}) {
  const n = mesa ?? ++secuencia;
  const votos = { C1: 30, C2: 20, C3: 5, BLANCO: 2, NULO: 1, NO_MARCADO: 0 };
  return {
    acta: `E14-7-${n}-03`,
    mesa: n,
    puesto: 7,
    municipio: 3,
    version,
    jurado,
    ts_cierre: 1793577600,
    votos,
    sufragantes: 58 + extra,
    hash_foto: 'f',
    idem: `http-${n}-v${version}-${extra}`,
  };
}

async function app(config = {}) {
  const a = await construirApp({ config: { ...BASE, ...config }, logger: false });
  await a.ready();
  return a;
}

const post = (a, payload) => a.inject({ method: 'POST', url: '/actas', payload });

describe.skipIf(!(await hayRedis()))('endpoints de actas con Redis real', () => {
  let a;
  let admin;
  beforeAll(async () => {
    a = await app();
    await esperarListo(a.redis);
    admin = new Redis(urlConDb(DB));
  });
  beforeEach(() => admin.flushdb());
  afterAll(async () => {
    await a?.close();
    await admin?.quit();
  });

  it('POST /actas: registrada (201) y su reenvío duplicada (200) con el mismo recibo', async () => {
    const x = acta();
    const r1 = await post(a, x);
    expect(r1.statusCode).toBe(201);
    expect(r1.headers['x-instance-id']).toBe('test-p1');
    expect(r1.json()).toMatchObject({ estado: 'registrada', version_vigente: 1 });
    const r2 = await post(a, x);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ estado: 'duplicada', recibo: r1.json().recibo });
  });

  it('POST /actas: dudosa → 202, conflicto → 409', async () => {
    expect((await post(a, acta({ extra: 4 }))).statusCode).toBe(202);
    const x = acta();
    await post(a, x);
    const r = await post(a, {
      ...x,
      votos: { ...x.votos, C1: 31 },
      sufragantes: 59,
      idem: 'otro-1234',
    });
    expect(r.statusCode).toBe(409);
  });

  it('GET /acumulado y /ranking devuelven los datos registrados', async () => {
    await post(a, acta());
    await post(a, acta());
    const acum = (await a.inject('/acumulado/pue/7')).json();
    expect(acum).toMatchObject({ nivel: 'pue', id: '7', mesas_informadas: 2, sufragantes: 116 });
    expect((await a.inject('/acumulado/dep')).json().votos.C1).toBe(60);
    expect((await a.inject('/ranking/mun/3?top=2')).json()).toEqual([
      { candidato: 'C1', votos: 60 },
      { candidato: 'C2', votos: 40 },
    ]);
  });
});

// ── Test obligatorio 7 (b): Redis colgado ──
// Un proxy TCP congelable hace de "Redis que no responde" solo para esta app (CLIENT PAUSE
// congelaría el servidor entero y rompería los demás tests que corren en paralelo).
describe.skipIf(!(await hayRedis()))('Redis colgado (conexión congelada)', () => {
  let a;
  let proxy;
  let admin;
  beforeAll(async () => {
    proxy = await proxyCongelable(urlConDb(DB));
    a = await app({ redisUrl: proxy.url });
    await esperarListo(a.redis);
    admin = new Redis(urlConDb(DB));
    await admin.flushdb();
    await post(a, acta()); // calienta la caché de scripts (EVALSHA) antes de congelar
  });
  afterAll(async () => {
    proxy?.descongelar();
    await a?.close();
    await admin?.quit();
    await proxy?.cerrar();
  });

  it('POST /actas: 503 en ≤ timeout + margen; al recuperarse, el reintento es idempotente', async () => {
    const x = acta();
    proxy.congelar();
    const t0 = performance.now();
    const r = await post(a, x);
    const ms = performance.now() - t0;
    const salud = await a.inject('/salud');

    expect(r.statusCode).toBe(503);
    expect(ms).toBeLessThan(BASE.redisCommandTimeoutMs + 300);
    expect(r.headers['retry-after']).toBeDefined();
    expect(r.json()).toMatchObject({ estado: 'no_registrada', reintentar: true });
    expect(salud.statusCode).toBe(503);

    // Al recuperarse, Redis ejecuta el comando que ya estaba en camino: el acta SÍ quedó
    // registrada aunque el jurado recibió 503. Su reintento lo descubre sin sumar dos veces.
    proxy.descongelar();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const reintento = await post(a, x);
    expect(reintento.json().estado).toBe('duplicada');
    expect((await a.inject('/acumulado/dep')).json().votos.C1).toBe(60); // 2 actas, no 3
    expect((await a.inject('/salud')).statusCode).toBe(200);
  }, 10_000);
});

// Una sola app activa a la vez: el dominio usa los clientes que registró la última app
// construida (como en producción, donde hay una app por proceso).
// ── Test obligatorio 6 ──
describe.skipIf(!(await hayRedis()))('límite de tasa por jurado', () => {
  let limitada;
  let admin;
  beforeAll(async () => {
    limitada = await app({ rlMax: 3, rlVentanaMs: 30_000 });
    await esperarListo(limitada.redis);
    admin = new Redis(urlConDb(DB));
    await admin.flushdb();
  });
  afterAll(async () => {
    await limitada?.close();
    await admin?.quit();
  });

  it('el envío n.º 4 de un jurado con RL_MAX=3 recibe 429 con Retry-After', async () => {
    const codigos = [];
    for (let i = 0; i < 4; i++)
      codigos.push((await post(limitada, acta({ jurado: 'JUR-RAFAGA' }))).statusCode);
    expect(codigos).toEqual([201, 201, 201, 429]);

    const r = await post(limitada, acta({ jurado: 'JUR-RAFAGA' }));
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(30);
    expect(r.json()).toMatchObject({ error: 'limite_tasa', jurado: 'JUR-RAFAGA' });
    // Otro jurado no se ve afectado.
    expect((await post(limitada, acta({ jurado: 'JUR-OTRO' }))).statusCode).toBe(201);
  });
});

// ── Test obligatorio 7 (a): Redis caído ──
describe('Redis caído (nadie escucha en el puerto)', () => {
  let a;
  beforeAll(async () => {
    a = await app({ redisUrl: 'redis://127.0.0.1:1' });
  });
  afterAll(() => a?.close());

  it('POST /actas responde 503 explícito en menos de 300 ms', async () => {
    const t0 = performance.now();
    const r = await post(a, acta());
    expect(performance.now() - t0).toBeLessThan(300);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ estado: 'no_registrada', reintentar: true });
  });

  it('las lecturas también fallan rápido con 503 y /salud lo refleja', async () => {
    expect((await a.inject('/acumulado/dep')).statusCode).toBe(503);
    const salud = await a.inject('/salud');
    expect(salud.statusCode).toBe(503);
    expect(salud.json()).toMatchObject({ estado: 'degradado', redis: 'sin_respuesta' });
  });

  it('/instancia sigue respondiendo (la instancia está viva aunque degradada)', async () => {
    expect((await a.inject('/instancia')).statusCode).toBe(200);
  });
});

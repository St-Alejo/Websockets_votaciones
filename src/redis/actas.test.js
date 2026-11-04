// Tests de registro contra un Redis REAL (base 11). Obligatorios 1, 2, 4 y 5 de Persona 1.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { aplicarVerificada, registrar } from './actas.js';
import { clientePrueba, hayRedis, urlConDb } from './pruebas.helper.js';
import { CANALES } from '../contratos/canales.js';
import { EventoActaNueva } from '../contratos/esquemas.js';
import * as K from '../contratos/keys.js';

const DB = 11;

/** Acta válida en mesa/puesto/municipio dados; `votos` parcial se completa con ceros. */
function acta({
  id = 'E14-001-0001-03',
  mesa = 1,
  puesto = 1,
  municipio = 1,
  version = 1,
  votos,
  extra = 0,
  idem,
}) {
  const v = { C1: 0, C2: 0, C3: 0, BLANCO: 0, NULO: 0, NO_MARCADO: 0, ...votos };
  const suma = Object.values(v).reduce((a, b) => a + b, 0);
  return {
    acta: id,
    mesa,
    puesto,
    municipio,
    version,
    jurado: 'JUR-1',
    ts_cierre: 1793577600,
    votos: v,
    sufragantes: suma + extra, // extra ≠ 0 → no cuadra → dudosa
    hash_foto: 'f',
    idem: idem ?? `${id}-v${version}-${extra}`,
  };
}

/** Todo el estado observable del acumulado: acum:*, rank:*, versión aplicada y cola. */
async function estado(redis) {
  const claves = (await redis.keys('acum:*')).concat(await redis.keys('rank:*')).sort();
  const out = {};
  for (const k of claves) {
    out[k] = k.startsWith('acum:')
      ? await redis.hgetall(k)
      : await redis.zrange(k, 0, -1, 'WITHSCORES');
  }
  for (const k of (await redis.keys('acta:*')).filter((x) => !x.endsWith(':versiones')).sort()) {
    out[k] = await redis.hmget(
      k,
      'version_aplicada',
      'votos',
      'sufragantes',
      'estado',
      'version_dudosa',
    );
  }
  out.cola = await redis.zrange(K.colaVerificacion, 0, -1, 'WITHSCORES');
  return out;
}

function* permutaciones(arr) {
  if (arr.length <= 1) return yield arr.slice();
  for (let i = 0; i < arr.length; i++) {
    const resto = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutaciones(resto)) yield [arr[i], ...p];
  }
}

describe.skipIf(!(await hayRedis()))('registro de actas (Redis real)', () => {
  let redis;
  beforeAll(async () => {
    redis = await clientePrueba(DB);
  });
  beforeEach(() => redis.flushdb());
  afterAll(() => redis?.quit());

  it('registra, suma en los 4 niveles y en los rankings, y deja rastro en el stream', async () => {
    const r = await registrar(redis, acta({ votos: { C1: 10, C2: 5, NULO: 1 } }));
    expect(r).toMatchObject({ estado: 'registrada', version: 1, version_vigente: 1 });
    expect(r.recibo).toMatch(/^R-/);
    for (const k of [K.acum('mesa', 1), K.acum('pue', 1), K.acum('mun', 1), K.acum('dep')]) {
      expect(await redis.hmget(k, 'C1', 'C2', 'NULO', 'sufragantes', 'informadas')).toEqual([
        '10',
        '5',
        '1',
        '16',
        '1',
      ]);
    }
    expect(await redis.zrevrange(K.rank('dep'), 0, -1, 'WITHSCORES')).toEqual([
      'C1',
      '10',
      'C2',
      '5',
      'C3',
      '0',
    ]);
    const [[, campos]] = await redis.xrange(K.streamActas, '-', '+');
    expect(JSON.parse(campos[1])).toMatchObject({
      acta: 'E14-001-0001-03',
      tipo: 'nueva',
      version: 1,
    });
  });

  it('publica un EventoActaNueva válido en acta:nueva', async () => {
    const sub = new Redis(urlConDb(DB));
    await sub.subscribe(CANALES.ACTA_NUEVA);
    // Pub/Sub es global al servidor (no por base): otros tests en paralelo también publican.
    // Se espera el evento de ESTA acta.
    const ID = 'E14-990-9901-03';
    const llegada = new Promise((resolve) =>
      sub.on('message', (_c, m) => {
        const e = JSON.parse(m);
        if (e.acta === ID) resolve(e);
      }),
    );
    await registrar(redis, acta({ id: ID, mesa: 9901, puesto: 990, votos: { C1: 1 } }));
    const evento = EventoActaNueva.parse(await llegada);
    expect(evento).toMatchObject({ acta: ID, mun: 1, pue: 990, version: 1, tipo: 'nueva' });
    await sub.quit();
  });

  // ── Test obligatorio 1 ──
  it('la misma acta enviada 5 veces en paralelo por 5 clientes distintos suma una sola vez', async () => {
    const clientes = await Promise.all(Array.from({ length: 5 }, () => clientePrueba(DB)));
    const a = acta({ votos: { C1: 100, C2: 50 } });
    const respuestas = await Promise.all(clientes.map((c) => registrar(c, a)));

    const estados = respuestas.map((r) => r.estado).sort();
    expect(estados).toEqual(['duplicada', 'duplicada', 'duplicada', 'duplicada', 'registrada']);
    const recibo = respuestas.find((r) => r.estado === 'registrada').recibo;
    expect(respuestas.every((r) => r.recibo === recibo)).toBe(true);
    expect(await redis.hmget(K.acum('dep'), 'C1', 'informadas')).toEqual(['100', '1']);
    expect(await redis.xlen(K.streamActas)).toBe(1);
    await Promise.all(clientes.map((c) => c.quit()));
  });

  // ── Test obligatorio 2 ──
  it('convergencia: las 720 permutaciones de llegada dan exactamente el mismo acumulado', async () => {
    const A = { id: 'E14-001-0001-03', mesa: 1, puesto: 1, municipio: 1 };
    const B = { id: 'E14-002-0002-03', mesa: 2, puesto: 2, municipio: 1 };
    const mensajes = [
      acta({ ...A, version: 1, votos: { C1: 10, C2: 20 } }),
      acta({ ...A, version: 2, votos: { C1: 15, C2: 18, BLANCO: 2 } }),
      acta({ ...A, version: 3, votos: { C1: 16, C2: 18, C3: 1, BLANCO: 2 } }),
      acta({ ...B, version: 1, votos: { C1: 7, C2: 3 } }),
      acta({ ...B, version: 2, votos: { C1: 8, C2: 4, NULO: 1 } }),
      acta({ ...B, version: 3, votos: { C1: 99 }, extra: 5 }), // dudosa: no debe aplicarse
    ];

    let referencia;
    let n = 0;
    for (const orden of permutaciones(mensajes)) {
      await redis.flushdb();
      for (const m of orden) await registrar(redis, m);
      const e = await estado(redis);
      if (!referencia) referencia = e;
      else expect(e).toEqual(referencia);
      n++;
    }
    expect(n).toBe(720);
    // El estado de referencia es el esperado: A en v3, B en v2 (su v3 dudosa queda en la cola).
    expect(referencia[K.acum('mun', 1)]).toMatchObject({
      C1: '24',
      C2: '22',
      C3: '1',
      BLANCO: '2',
      NULO: '1',
      informadas: '2',
      sufragantes: '50',
    });
    expect(referencia[K.acta(B.id)][0]).toBe('2');
    expect(referencia[K.acta(B.id)][4]).toBe('3');
    expect(referencia.cola).toEqual([B.id, '5']);
  }, 60_000);

  it('una corrección revierte la versión anterior; una versión vieja tardía no retrocede', async () => {
    await registrar(redis, acta({ version: 1, votos: { C1: 10 } }));
    const v3 = await registrar(redis, acta({ version: 3, votos: { C1: 30 } }));
    expect(v3.estado).toBe('registrada');
    const v2 = await registrar(redis, acta({ version: 2, votos: { C1: 20 } }));
    expect(v2).toMatchObject({ estado: 'version_obsoleta', version_vigente: 3 });
    expect(await redis.hmget(K.acum('dep'), 'C1', 'informadas')).toEqual(['30', '1']);
    const tipos = (await redis.xrange(K.streamActas, '-', '+')).map(
      ([, c]) => JSON.parse(c[1]).tipo,
    );
    expect(tipos).toEqual(['nueva', 'correccion']);
  });

  it('misma versión con contenido distinto → conflicto, sin cambios', async () => {
    await registrar(redis, acta({ votos: { C1: 10 } }));
    const r = await registrar(redis, acta({ votos: { C1: 11 }, idem: 'otro-idem-123' }));
    expect(r).toMatchObject({ estado: 'conflicto', recibo: null, version_vigente: 1 });
    expect(await redis.hget(K.acum('dep'), 'C1')).toBe('10');
  });

  it('un idem reutilizado para otra acta → conflicto', async () => {
    await registrar(redis, acta({ votos: { C1: 1 }, idem: 'idem-compartido' }));
    const r = await registrar(
      redis,
      acta({ id: 'E14-002-0002-03', mesa: 2, votos: { C1: 1 }, idem: 'idem-compartido' }),
    );
    expect(r.estado).toBe('conflicto');
  });

  // ── Test obligatorio 4 ──
  it('idem expirado: borrar idem:{x} y reenviar devuelve duplicada y no suma', async () => {
    const a = acta({ votos: { C1: 40 } });
    const original = await registrar(redis, a);
    await redis.del(K.idem(a.idem));
    const reenvio = await registrar(redis, a);
    expect(reenvio).toMatchObject({ estado: 'duplicada', recibo: original.recibo });
    // Un idem nuevo con el mismo contenido (p. ej. la app perdió su estado) tampoco suma.
    const otroIdem = await registrar(redis, { ...a, idem: 'idem-regenerado-1' });
    expect(otroIdem).toMatchObject({ estado: 'duplicada', recibo: original.recibo });
    expect(await redis.hget(K.acum('dep'), 'C1')).toBe('40');
    expect(await redis.ttl(K.idem(a.idem))).toBeGreaterThan(86_000); // se re-creó
  });

  // ── Test obligatorio 5 ──
  it('acta que no cuadra → dudosa, no suma y entra en cola:verificacion', async () => {
    const r = await registrar(redis, acta({ votos: { C1: 10 }, extra: 3 }));
    expect(r.estado).toBe('dudosa');
    expect(r.recibo).toMatch(/^R-/);
    expect(await redis.exists(K.acum('dep'), K.acum('mesa', 1))).toBe(0);
    expect(await redis.zscore(K.colaVerificacion, 'E14-001-0001-03')).toBe('3');
    expect(await redis.hmget(K.acta('E14-001-0001-03'), 'estado', 'version_dudosa')).toEqual([
      'dudosa',
      '1',
    ]);
    expect(await redis.xlen(K.streamActas)).toBe(0);
  });

  it('aplicarVerificada aplica la dudosa aprobada y la saca de la cola', async () => {
    await registrar(redis, acta({ version: 1, votos: { C1: 10 } }));
    await registrar(redis, acta({ version: 2, votos: { C1: 12 }, extra: 1 }));
    expect(await redis.hget(K.acum('dep'), 'C1')).toBe('10');

    const r = await aplicarVerificada(redis, 'E14-001-0001-03', 2);
    expect(r).toMatchObject({ aplicada: true, version_vigente: 2 });
    expect(r.stream_id).toMatch(/^\d+-\d+$/);
    expect(await redis.hmget(K.acum('dep'), 'C1', 'informadas')).toEqual(['12', '1']);
    expect(await redis.zcard(K.colaVerificacion)).toBe(0);
    expect(await aplicarVerificada(redis, 'E14-001-0001-03', 2)).toMatchObject({ aplicada: false });
    expect(await aplicarVerificada(redis, 'E14-001-0001-03', 7)).toMatchObject({ aplicada: false });
  });

  it('una versión válida mayor retira de la cola a una dudosa menor', async () => {
    await registrar(redis, acta({ version: 1, votos: { C1: 10 }, extra: 2 }));
    expect(await redis.zcard(K.colaVerificacion)).toBe(1);
    await registrar(redis, acta({ version: 2, votos: { C1: 11 } }));
    expect(await redis.zcard(K.colaVerificacion)).toBe(0);
    expect(await redis.hget(K.acta('E14-001-0001-03'), 'estado')).toBe('aplicada');
  });

  it('JSON inválido → rechazada sin tocar Redis', async () => {
    const r = await registrar(redis, { acta: 'x', version: 1 });
    expect(r).toMatchObject({ estado: 'rechazada', recibo: null });
    expect(await redis.dbsize()).toBe(0);
  });
});

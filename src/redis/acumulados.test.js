// Snapshot, ranking e historial contra un Redis REAL (base 12). Test obligatorio 3.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registrar } from './actas.js';
import { leerRanking, leerSnapshot } from './acumulados.js';
import { compararIds, leerDesde, ultimoId } from './historial.js';
import { clientePrueba, hayRedis } from './pruebas.helper.js';
import { sembrarCatalogo } from '../dominio/catalogo.js';
import { Acumulado, Snapshot } from '../contratos/esquemas.js';
import * as K from '../contratos/keys.js';

const DB = 12;

function acta(n, { puesto = 1, municipio = 1, version = 1, c1 = 10, c2 = 5 } = {}) {
  return {
    acta: `E14-${puesto}-${n}-03`,
    mesa: n,
    puesto,
    municipio,
    version,
    jurado: `JUR-${n}`,
    ts_cierre: 1793577600,
    votos: { C1: c1, C2: c2, C3: 1, BLANCO: 1, NULO: 0, NO_MARCADO: 0 },
    sufragantes: c1 + c2 + 2,
    hash_foto: 'f',
    idem: `idem-${n}-v${version}`,
  };
}

describe.skipIf(!(await hayRedis()))('acumulados, snapshot e historial (Redis real)', () => {
  let redis;
  beforeAll(async () => {
    redis = await clientePrueba(DB);
  });
  beforeEach(() => redis.flushdb());
  afterAll(() => redis?.quit());

  it('snapshot de varios niveles: Acumulado válido, % informado y último stream_id', async () => {
    await sembrarCatalogo(redis);
    const total = Number(await redis.get(K.catalogo('pue', 1)));
    await registrar(redis, acta(1));
    await registrar(redis, acta(2, { c1: 3 }));

    const s = Snapshot.parse(await leerSnapshot(redis, ['dep', 'mun:1', 'pue:1', 'mesa:1']));
    expect(s.stream_id).toBe(await ultimoId(redis));
    expect(s.niveles.dep).toMatchObject({
      votos: { C1: 13, C2: 10 },
      mesas_informadas: 2,
      mesas_totales: 6400,
    });
    expect(s.niveles['pue:1'].mesas_totales).toBe(total);
    expect(s.niveles['pue:1'].porcentaje_informado).toBeCloseTo((2 / total) * 100, 1);
    expect(s.niveles['mesa:1']).toMatchObject({
      sufragantes: 17,
      mesas_totales: 1,
      porcentaje_informado: 100,
    });
  });

  it('un nivel sin datos devuelve ceros, no error', async () => {
    const { niveles, stream_id } = await leerSnapshot(redis, ['mun:999']);
    expect(Acumulado.parse(niveles['mun:999'])).toMatchObject({
      sufragantes: 0,
      mesas_informadas: 0,
    });
    expect(stream_id).toBe('0-0');
  });

  it('ranking: top N ordenado desde el ZSET y desde el HASH de la mesa', async () => {
    await registrar(redis, acta(1, { c1: 3, c2: 9 }));
    await registrar(redis, acta(2, { c1: 4, c2: 1 }));
    expect(await leerRanking(redis, 'dep', null, 2)).toEqual([
      { candidato: 'C2', votos: 10 },
      { candidato: 'C1', votos: 7 },
    ]);
    expect(await leerRanking(redis, 'mesa', 1, 1)).toEqual([{ candidato: 'C2', votos: 9 }]);
  });

  // ── Test obligatorio 3 ──
  it('atomicidad: con escrituras concurrentes, ningún snapshot ve un municipio ≠ suma de sus puestos', async () => {
    const PUESTOS = [1, 2, 3, 4];
    const topicos = ['mun:1', ...PUESTOS.map((p) => `pue:${p}`)];
    const escritores = await Promise.all(PUESTOS.map(() => clientePrueba(DB)));
    let escribiendo = true;
    let lecturas = 0;
    const violaciones = [];

    const lector = (async () => {
      while (escribiendo) {
        const { niveles } = await leerSnapshot(redis, topicos);
        for (const campo of ['C1', 'C2', 'C3', 'BLANCO']) {
          const suma = PUESTOS.reduce((a, p) => a + (niveles[`pue:${p}`].votos[campo] ?? 0), 0);
          if ((niveles['mun:1'].votos[campo] ?? 0) !== suma) violaciones.push({ campo, lecturas });
        }
        const inf = PUESTOS.reduce((a, p) => a + niveles[`pue:${p}`].mesas_informadas, 0);
        if (niveles['mun:1'].mesas_informadas !== inf)
          violaciones.push({ campo: 'informadas', lecturas });
        lecturas++;
      }
    })();

    // Cada escritor (una "instancia") registra 150 actas de su puesto y corrige 30.
    await Promise.all(
      escritores.map(async (c, i) => {
        const puesto = PUESTOS[i];
        for (let n = 0; n < 150; n++)
          await registrar(c, acta(puesto * 1000 + n, { puesto, c1: n % 17 }));
        for (let n = 0; n < 30; n++) {
          await registrar(c, acta(puesto * 1000 + n, { puesto, version: 2, c1: 50, c2: n }));
        }
      }),
    );
    escribiendo = false;
    await lector;

    expect(lecturas).toBeGreaterThan(20);
    expect(violaciones).toEqual([]);
    const { niveles } = await leerSnapshot(redis, ['mun:1']);
    expect(niveles['mun:1'].mesas_informadas).toBe(600);
    await Promise.all(escritores.map((c) => c.quit()));
  }, 30_000);

  it('historial: eventos posteriores al cursor, en orden, con paginación', async () => {
    for (let n = 1; n <= 5; n++) await registrar(redis, acta(n));
    const todo = await leerDesde(redis, '0-0', 100);
    expect(todo.eventos.map((e) => e.acta)).toEqual([1, 2, 3, 4, 5].map((n) => `E14-1-${n}-03`));
    expect(todo.recortado).toBeUndefined();

    const p1 = await leerDesde(redis, '0-0', 2);
    expect(p1).toMatchObject({ hay_mas: true });
    const p2 = await leerDesde(redis, p1.stream_id, 10);
    expect(p2.eventos.map((e) => e.mesa ?? e.acta)).toHaveLength(3);
    expect(compararIds(p2.eventos[0].stream_id, p1.stream_id)).toBe(1);

    const alDia = await leerDesde(redis, todo.stream_id, 10);
    expect(alDia).toMatchObject({ eventos: [], stream_id: todo.stream_id });
  });

  it('historial: si el cursor quedó antes de lo recortado, avisa recortado (pedir snapshot)', async () => {
    for (let n = 1; n <= 20; n++) await registrar(redis, acta(n));
    const [[primero]] = await redis.xrange(K.streamActas, '-', '+', 'COUNT', 1);
    await redis.xtrim(K.streamActas, 'MAXLEN', 5);
    const r = await leerDesde(redis, primero, 100);
    expect(r.recortado).toBe(true);
    const reciente = await leerDesde(redis, await ultimoId(redis), 100);
    expect(reciente.recortado).toBeUndefined();
  });

  it('historial: stream vacío o cursor inválido', async () => {
    expect(await leerDesde(redis, '0-0', 10)).toEqual({ eventos: [], stream_id: '0-0' });
    expect((await leerDesde(redis, 'basura', 10)).recortado).toBe(true);
  });
});

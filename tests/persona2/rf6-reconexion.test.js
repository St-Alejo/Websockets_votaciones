import { describe, expect, it } from 'vitest';
import {
  afectaTopico,
  backoffExponencial,
  crearClienteReconexion,
  decidirReanudacion,
  directivaRetry,
  leerCursor,
} from '../../src/transport/reconexion.js';

function evento(parcial) {
  return {
    stream_id: '1-0',
    acta: 'E14-176-0042-03',
    mun: 11,
    pue: 176,
    version: 1,
    tipo: 'nueva',
    ...parcial,
  };
}

describe('RF-6 cursor y reanudación', () => {
  it('lee Last-Event-ID antes que ultimo_id', () => {
    expect(
      leerCursor({
        headers: { 'last-event-id': '10-1' },
        query: { ultimo_id: '1-0' },
      }),
    ).toBe('10-1');
    expect(leerCursor({ headers: {}, query: { ultimo_id: '8-0' } })).toBe('8-0');
    expect(leerCursor({ headers: { 'last-event-id': '  ' }, query: {} })).toBeNull();
  });

  it('filtra eventos por la jerarquía del tópico', () => {
    const ev = evento();
    expect(afectaTopico(ev, 'dep')).toBe(true);
    expect(afectaTopico(ev, 'mun:11')).toBe(true);
    expect(afectaTopico(ev, 'mun:12')).toBe(false);
    expect(afectaTopico(ev, 'pue:176')).toBe(true);
    expect(afectaTopico(ev, 'pue:1')).toBe(false);
  });

  it('sin cursor, o con el stream recortado, manda snapshot', async () => {
    const foto = { niveles: {}, stream_id: '50-0' };
    const snapshot = async () => foto;
    const sinCursor = await decidirReanudacion({
      cursor: null,
      topico: 'mun:11',
      snapshot,
      historial: { leerDesde: async () => ({ eventos: [] }) },
    });
    expect(sinCursor).toMatchObject({ modo: 'snapshot', motivo: 'sin_cursor', snapshot: foto });

    const recortado = await decidirReanudacion({
      cursor: '1-0',
      topico: 'dep',
      snapshot,
      historial: {
        leerDesde: async () => ({ eventos: [], stream_id: '9-0', recortado: true }),
      },
    });
    expect(recortado).toMatchObject({ modo: 'snapshot', motivo: 'historial_recortado' });

    const hueco = await decidirReanudacion({
      cursor: '1-0',
      topico: 'dep',
      maxDeltas: 2,
      snapshot,
      historial: {
        leerDesde: async () => ({
          eventos: [evento({ stream_id: '2-0' }), evento({ stream_id: '3-0' })],
          stream_id: '3-0',
          recortado: false,
          hayMas: true,
        }),
      },
    });
    expect(hueco.modo).toBe('snapshot');
    expect(hueco.motivo).toBe('hueco_grande');
  });

  it('reenvía solo los deltas del tópico que faltan', async () => {
    const plan = await decidirReanudacion({
      cursor: '5-0',
      topico: 'mun:11',
      maxDeltas: 10,
      snapshot: async () => {
        throw new Error('no debía pedir snapshot');
      },
      historial: {
        leerDesde: async (cursor, max) => {
          expect(cursor).toBe('5-0');
          expect(max).toBe(10);
          return {
            eventos: [
              evento({ stream_id: '6-0', mun: 11 }),
              evento({ stream_id: '7-0', mun: 99, pue: 2, acta: 'E14-002-0001-03' }),
            ],
            stream_id: '7-0',
            recortado: false,
            hayMas: false,
          };
        },
      },
    });
    expect(plan.modo).toBe('deltas');
    expect(plan.eventos.map((e) => e.stream_id)).toEqual(['6-0']);
  });

  it('el campo hay_mas del historial de main obliga a un snapshot', async () => {
    const plan = await decidirReanudacion({
      cursor: '5-0',
      topico: 'dep',
      maxDeltas: 10,
      snapshot: async () => ({ niveles: {}, stream_id: '9-0' }),
      historial: {
        leerDesde: async () => ({
          eventos: [evento({ stream_id: '6-0' })],
          stream_id: '6-0',
          hay_mas: true,
        }),
      },
    });
    expect(plan.modo).toBe('snapshot');
    expect(plan.motivo).toBe('hueco_grande');
  });
});

describe('RF-10 backoff con jitter', () => {
  it('el techo crece exponencial y el jitter reparte las esperas', () => {
    const bajo = backoffExponencial({
      intento: 0,
      baseMs: 1000,
      maxMs: 30_000,
      aleatorio: () => 0,
    });
    const alto = backoffExponencial({
      intento: 0,
      baseMs: 1000,
      maxMs: 30_000,
      aleatorio: () => 0.999,
    });
    expect(bajo.techoMs).toBe(1000);
    expect(bajo.esperaMs).toBe(500);
    expect(alto.esperaMs).toBeGreaterThan(bajo.esperaMs);
    expect(alto.esperaMs).toBeLessThanOrEqual(1000);

    expect(
      backoffExponencial({ intento: 3, baseMs: 1000, maxMs: 30_000, aleatorio: () => 0 }).techoMs,
    ).toBe(8000);
    expect(
      backoffExponencial({ intento: 20, baseMs: 1000, maxMs: 30_000, aleatorio: () => 0 }).techoMs,
    ).toBe(30_000);

    const esperas = new Set(
      Array.from(
        { length: 30 },
        (_, i) =>
          backoffExponencial({
            intento: 4,
            baseMs: 1000,
            maxMs: 30_000,
            aleatorio: () => (i + 1) / 31,
          }).esperaMs,
      ),
    );
    expect(esperas.size).toBeGreaterThan(10);

    const retries = new Set(
      Array.from({ length: 20 }, (_, i) => directivaRetry(() => (i + 1) / 21)),
    );
    expect(retries.size).toBeGreaterThan(5);
  });

  it('el cliente reintenta con esperas crecientes y se estabiliza al conectar', async () => {
    let fallos = 0;
    const programados = [];
    const cliente = crearClienteReconexion({
      conectar: async () => {
        fallos += 1;
        if (fallos < 3) throw new Error('caido');
      },
      baseMs: 100,
      maxMs: 10_000,
      aleatorio: () => 0.5,
      programar: (fn, ms) => {
        programados.push({ fn, ms });
        return programados.length;
      },
      cancelar() {},
    });

    await cliente.arrancar();
    expect(programados).toHaveLength(1);
    await programados[0].fn();
    expect(programados).toHaveLength(2);
    expect(programados[1].ms).toBeGreaterThan(programados[0].ms);
    await programados[1].fn();
    expect(cliente.intento).toBe(0);
    expect(fallos).toBe(3);
  });
});

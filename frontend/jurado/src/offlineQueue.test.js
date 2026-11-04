// Tests RT-6 de la cola offline (node:test, sin navegador).
// El storage real (IndexedDB) vive en idb.js; aquí un memoria equivalente.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crearColaOffline, ESTADOS } from './offlineQueue.js';

function memoria() {
  const mapa = new Map();
  return {
    async put(e) {
      mapa.set(e.id, { ...e });
    },
    async get(id) {
      return mapa.get(id) ?? null;
    },
    async getAll() {
      return [...mapa.values()];
    },
  };
}

const acta = (idemExtra = {}) => ({
  acta: 'E14-176-4201-3',
  mesa: 4201,
  puesto: 176,
  municipio: 11,
  version: 1,
  jurado: 'JUR-1',
  ts_cierre: 1793577600,
  votos: { C1: 184, C2: 97, C3: 311, BLANCO: 22, NULO: 9, NO_MARCADO: 4 },
  sufragantes: 627,
  hash_foto: 'x',
  idem: 'idem-test',
  ...idemExtra,
});

const sinEspera = (ms) => {
  sinEspera.llamadas.push(ms);
  return Promise.resolve();
};
sinEspera.llamadas = [];

describe('RT-6 cola offline', () => {
  it('guardar crea PENDING persistido con idem único', async () => {
    const cola = crearColaOffline({ storage: memoria(), esperar: sinEspera });
    const e = await cola.guardar(acta());
    assert.equal(e.estado, ESTADOS.PENDING);
    assert.ok(e.idem);
    assert.equal((await cola.listar()).length, 1);
  });

  it('procesar confirma solo con ACK del servidor', async () => {
    const cola = crearColaOffline({ storage: memoria(), esperar: sinEspera });
    await cola.guardar(acta());
    await cola.procesar({
      puedeEnviar: () => true,
      enviar: async () => ({ estado: 'registrada', acta: 'E14-176-4201-3', version: 1, recibo: 'R1' }),
    });
    const [e] = await cola.listar();
    assert.equal(e.estado, ESTADOS.ACKNOWLEDGED);
    assert.equal(e.respuesta.recibo, 'R1');
  });

  it('fallo de red: backoff progresivo y FAILED tras agotar intentos (nunca se borra)', async () => {
    const demora = [];
    const cola = crearColaOffline({
      storage: memoria(),
      esperar: (ms) => {
        demora.push(ms);
        return Promise.resolve();
      },
      baseMs: 1000,
      maxMs: 8000,
      maxIntentos: 3,
    });
    await cola.guardar(acta());
    await cola.procesar({
      puedeEnviar: () => true,
      enviar: async () => {
        throw new Error('red caída');
      },
    });
    assert.equal(demora.length, 2); // 3 intentos, 2 esperas entre ellos
    assert.ok(demora[0] >= 2000 && demora[0] < 2600, `d1=${demora[0]}`);
    assert.ok(demora[1] >= 4000 && demora[1] < 4600, `d2=${demora[1]}`);
    const [e] = await cola.listar();
    assert.equal(e.estado, ESTADOS.FAILED);
    assert.equal(e.intentos, 3);
    assert.match(e.ultimoError, /red caída/);
  });

  it('fallo y luego éxito: reintenta con el mismo idem y confirma', async () => {
    const cola = crearColaOffline({ storage: memoria(), esperar: sinEspera, maxIntentos: 5 });
    const g = await cola.guardar(acta());
    let vez = 0;
    await cola.procesar({
      puedeEnviar: () => true,
      enviar: async (envio) => {
        vez += 1;
        assert.equal(envio.idem, g.idem);
        if (vez === 1) throw new Error('corte breve');
        return { estado: 'registrada', acta: envio.acta.acta, version: 1, recibo: 'R2' };
      },
    });
    assert.equal(vez, 2);
    const [e] = await cola.listar();
    assert.equal(e.estado, ESTADOS.ACKNOWLEDGED);
    assert.equal(e.intentos, 1);
  });

  it('los reintentos reutilizan el MISMO idem (sin duplicados en servidor)', async () => {
    const idems = [];
    const cola = crearColaOffline({ storage: memoria(), esperar: sinEspera });
    const g = await cola.guardar(acta());
    let vez = 0;
    await cola.procesar({
      puedeEnviar: () => true,
      enviar: async (envio) => {
        idems.push(envio.idem);
        vez += 1;
        if (vez === 1) throw new Error('corte');
        return { estado: 'duplicada', acta: envio.acta.acta, version: 1, recibo: 'R1' };
      },
    });
    assert.equal(idems[0], g.idem);
    // Segundo procesar (tras el backoff programado) reenvía con el mismo idem.
    await cola.procesar({
      puedeEnviar: () => true,
      enviar: async (envio) => {
        idems.push(envio.idem);
        return { estado: 'duplicada', acta: envio.acta.acta, version: 1, recibo: 'R1' };
      },
    });
    assert.deepEqual(idems, [g.idem, g.idem]);
    const [e] = await cola.listar();
    assert.equal(e.estado, ESTADOS.ACKNOWLEDGED);
  });

  it('sin transporte no se toca nada', async () => {
    const cola = crearColaOffline({ storage: memoria(), esperar: sinEspera });
    await cola.guardar(acta());
    let llamadas = 0;
    await cola.procesar({ puedeEnviar: () => false, enviar: async () => llamadas++ });
    assert.equal(llamadas, 0);
    assert.equal((await cola.listar())[0].estado, ESTADOS.PENDING);
  });

  it('rechazada → FAILED con motivo y sin reintento automático', async () => {
    const cola = crearColaOffline({ storage: memoria(), esperar: sinEspera });
    await cola.guardar(acta());
    await cola.procesar({
      puedeEnviar: () => true,
      enviar: async () => ({ estado: 'rechazada', acta: 'x', version: 0, recibo: null, motivo: 'votos: faltan' }),
    });
    const [e] = await cola.listar();
    assert.equal(e.estado, ESTADOS.FAILED);
    assert.match(e.ultimoError, /votos/);
  });

  it('recargar recupera los PENDING del mismo storage', async () => {
    const st = memoria();
    const c1 = crearColaOffline({ storage: st, esperar: sinEspera });
    await c1.guardar(acta());
    const c2 = crearColaOffline({ storage: st, esperar: sinEspera });
    assert.equal((await c2.listar()).length, 1);
    await c2.procesar({
      puedeEnviar: () => true,
      enviar: async () => ({ estado: 'registrada', acta: 'E14-176-4201-3', version: 1, recibo: 'R9' }),
    });
    assert.equal((await c2.listar())[0].respuesta.recibo, 'R9');
  });

  it('reintentar pasa FAILED a PENDING', async () => {
    const cola = crearColaOffline({ storage: memoria(), esperar: sinEspera });
    const g = await cola.guardar(acta());
    await cola.procesar({
      puedeEnviar: () => true,
      enviar: async () => ({ estado: 'rechazada', acta: 'x', version: 0, recibo: null }),
    });
    assert.equal((await cola.obtener(g.id)).estado, ESTADOS.FAILED);
    await cola.reintentar(g.id);
    assert.equal((await cola.obtener(g.id)).estado, ESTADOS.PENDING);
  });
});

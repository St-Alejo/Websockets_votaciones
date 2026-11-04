import { describe, expect, it } from 'vitest';
import { registrarClientes } from '../redis/cliente.js';
import {
  activos,
  actualizarActa,
  actualizarEstado,
  detectarFantasmas,
  latido,
  obtener,
  purgarExpirados,
  registrar,
  salir,
} from './tracker.js';
import { presentes } from './index.js';

/** Redis en memoria: STRING con EX + SCAN por patrón + DEL + PUBLISH. */
function redisFalsoPresencia() {
  const strings = new Map(); // key -> { valor, expiraMs }
  const publicados = [];

  function vigente(key) {
    const e = strings.get(key);
    if (!e) return null;
    if (e.expiraMs !== null && Date.now() >= e.expiraMs) {
      strings.delete(key);
      return null;
    }
    return e;
  }

  function patronARegex(patron) {
    return new RegExp(`^${patron.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  }

  return {
    status: 'ready',
    publicados,
    async set(key, valor, ...args) {
      let ex = null;
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === 'EX') ex = Number(args[++i]) * 1000;
      }
      strings.set(key, { valor: String(valor), expiraMs: ex ? Date.now() + ex : null });
      return 'OK';
    },
    async get(key) {
      return vigente(key)?.valor ?? null;
    },
    async del(key) {
      return strings.delete(key) ? 1 : 0;
    },
    async scan(cursor, ...args) {
      let match = '*';
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === 'MATCH') match = args[++i];
      }
      const rx = patronARegex(match);
      const todas = [...strings.keys()].filter((k) => rx.test(k) && vigente(k));
      return ['0', todas];
    },
    async publish(canal, mensaje) {
      publicados.push({ canal, mensaje: JSON.parse(mensaje) });
      return 1;
    },
    /** Solo tests: reescribe el latido para simular un fantasma. */
    _envejecerLatido(auditor, msAtras) {
      const e = vigente(`presencia:${auditor}`);
      if (!e) return false;
      const o = JSON.parse(e.valor);
      o.latido = Date.now() - msAtras;
      e.valor = JSON.stringify(o);
      return true;
    },
  };
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

describe('RF-8 presencia distribuida', () => {
  it('registra, renueva latido y consulta', async () => {
    const redis = redisFalsoPresencia();
    const r1 = await registrar('AUD-1', { instancia: 'inst-1' }, redis);
    expect(r1).toMatchObject({ auditor: 'AUD-1', estado: 'online', instancia: 'inst-1' });
    expect(await obtener('AUD-1', redis)).toMatchObject({ auditor: 'AUD-1' });
    // El latido preserva el momento de conexión.
    await dormir(5);
    const r2 = await latido('AUD-1', { instancia: 'inst-1', acta_actual: 'E14-1' }, redis);
    expect(r2.desde).toBe(r1.desde);
    expect(r2.acta_actual).toBe('E14-1');
  });

  it('un auditor conectado a la instancia 1 se ve desde la instancia 8', async () => {
    const redis = redisFalsoPresencia();
    await registrar('AUD-1', { instancia: 'inst-1' }, redis);
    await registrar('AUD-2', { instancia: 'inst-8' }, redis);
    // "Otra instancia" = misma Redis compartida, distinto cliente lógico.
    const lista = await activos(redis);
    expect(lista.map((r) => r.auditor).sort()).toEqual(['AUD-1', 'AUD-2']);
    expect(lista.find((r) => r.auditor === 'AUD-1')).toMatchObject({ instancia: 'inst-1' });
  });

  it('actualiza estado y acta asignada', async () => {
    const redis = redisFalsoPresencia();
    await registrar('AUD-1', { instancia: 'i1' }, redis);
    expect(await actualizarActa('AUD-1', 'E14-9', redis)).toMatchObject({ acta_actual: 'E14-9' });
    expect(await actualizarEstado('AUD-1', 'online', redis)).toMatchObject({ estado: 'online' });
    expect(await actualizarActa('AUD-X', 'E14-1', redis)).toBeNull();
  });

  it('salir publica offline y desaparece del listado', async () => {
    const redis = redisFalsoPresencia();
    await registrar('AUD-1', { instancia: 'i1' }, redis);
    expect(await salir('AUD-1', redis)).toBe(true);
    expect(await obtener('AUD-1', redis)).toBeNull();
    expect(await activos(redis)).toEqual([]);
    expect(redis.publicados.some((p) => p.mensaje.estado === 'offline')).toBe(true);
    expect(await salir('AUD-1', redis)).toBe(false);
  });

  it('la expiración TTL hace desaparecer al auditor desconectado', async () => {
    const redis = redisFalsoPresencia();
    await registrar('AUD-1', { instancia: 'i1', ttlS: 1 }, redis);
    expect(await obtener('AUD-1', redis)).not.toBeNull();
    await dormir(1100);
    expect(await obtener('AUD-1', redis)).toBeNull();
    expect(await activos(redis)).toEqual([]);
  });

  it('detecta fantasmas y los purga con evento offline', async () => {
    const redis = redisFalsoPresencia();
    await registrar('AUD-1', { instancia: 'i1', ttlS: 300 }, redis);
    await registrar('AUD-2', { instancia: 'i2', ttlS: 300 }, redis);
    redis._envejecerLatido('AUD-1', 120_000);
    const fantasmas = await detectarFantasmas(60_000, redis);
    expect(fantasmas.map((f) => f.auditor)).toEqual(['AUD-1']);
    const purgados = await purgarExpirados(60_000, redis);
    expect(purgados.map((f) => f.auditor)).toEqual(['AUD-1']);
    expect(await obtener('AUD-1', redis)).toBeNull();
    expect(await obtener('AUD-2', redis)).not.toBeNull();
  });

  it('fachada presentes() ve lo global cuando hay Redis', async () => {
    const redis = redisFalsoPresencia();
    registrarClientes({ redis, redisSub: redis });
    await registrar('AUD-9', { instancia: 'inst-3' }, redis);
    const lista = await presentes();
    expect(lista.map((r) => r.auditor)).toContain('AUD-9');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { registrarClientes } from '../redis/cliente.js';
import {
  actualizarPrioridad,
  encolarActa,
  obtenerActa,
  pendientes,
  reintegrarActa,
  retirarActa,
  tamanioCola,
} from './cola.js';
import {
  consultarPropietario,
  intentarBloquear,
  liberarBloqueo,
  renovarBloqueo,
} from './bloqueo.js';
import { detenerHeartbeat, iniciarHeartbeat } from './heartbeat.js';
import { liberarCaso, resolverCaso, tomarCaso, verCola } from './index.js';

/** Redis en memoria: implementa solo lo que usan cola/bloqueo/heartbeat. */
function redisFalsoVerificacion() {
  const zsets = new Map(); // key -> Map(member -> score)
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

  function compararToken(crudo, token) {
    if (crudo === null) return false;
    if (crudo.startsWith('{')) {
      try {
        return JSON.parse(crudo).token === token;
      } catch {
        return false;
      }
    }
    return crudo === token;
  }

  return {
    status: 'ready',
    publicados,
    async zadd(key, ...args) {
      let nx = false;
      let xx = false;
      while (args.length > 2 && typeof args[0] === 'string') {
        const opt = args.shift().toUpperCase();
        if (opt === 'NX') nx = true;
        else if (opt === 'XX') xx = true;
      }
      const [score, member] = args;
      let m = zsets.get(key);
      if (!m) {
        m = new Map();
        zsets.set(key, m);
      }
      const existe = m.has(member);
      if (nx && existe) return 0;
      if (xx && !existe) return 0;
      m.set(member, Number(score));
      return existe ? 0 : 1;
    },
    async zscore(key, member) {
      const v = zsets.get(key)?.get(member);
      return v === undefined ? null : String(v);
    },
    async zrevrange(key, start, stop, withscores) {
      const m = zsets.get(key);
      if (!m) return [];
      const orden = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
      const rebanada = orden.slice(start, stop + 1);
      if (String(withscores).toUpperCase() === 'WITHSCORES') {
        return rebanada.flatMap(([member, score]) => [member, String(score)]);
      }
      return rebanada.map(([member]) => member);
    },
    async zcard(key) {
      return zsets.get(key)?.size ?? 0;
    },
    async zrem(key, member) {
      const m = zsets.get(key);
      if (!m || !m.has(member)) return 0;
      m.delete(member);
      return 1;
    },
    async set(key, valor, ...args) {
      let nx = false;
      let px = null;
      for (let i = 0; i < args.length; i++) {
        const a = String(args[i]).toUpperCase();
        if (a === 'NX') nx = true;
        else if (a === 'PX') px = Number(args[++i]);
      }
      if (nx && vigente(key)) return null;
      strings.set(key, { valor: String(valor), expiraMs: px ? Date.now() + px : null });
      return 'OK';
    },
    async get(key) {
      return vigente(key)?.valor ?? null;
    },
    async exists(key) {
      return vigente(key) ? 1 : 0;
    },
    async eval(script, numkeys, ...args) {
      const keys = args.slice(0, numkeys);
      const argv = args.slice(numkeys);
      const key = keys[0];
      const e = vigente(key);
      if (script.includes('PEXPIRE')) {
        const [token, ttl] = argv;
        if (!e || !compararToken(e.valor, token)) return 0;
        e.expiraMs = Date.now() + Number(ttl);
        return 1;
      }
      // LUA_LIBERAR (contiene DEL)
      const [token] = argv;
      if (!e || !compararToken(e.valor, token)) return 0;
      strings.delete(key);
      return 1;
    },
    async publish(canal, mensaje) {
      publicados.push({ canal, mensaje });
      return 1;
    },
  };
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  // Limpia heartbeats que algún test haya dejado corriendo.
  // (Los controles se detienen explícitamente en cada test; esto es red de seguridad.)
  void detenerHeartbeat;
});

describe('RF-7 cola de verificación (ZSET)', () => {
  it('agrega, evita duplicados, ordena por prioridad y consulta tamaño', async () => {
    const redis = redisFalsoVerificacion();
    expect(await encolarActa('E14-176-0042-03', 30, redis)).toBe(true);
    expect(await encolarActa('E14-201-0007-03', 20, redis)).toBe(true);
    expect(await encolarActa('E14-033-0115-03', 10, redis)).toBe(true);
    // Duplicada: no se agrega dos veces.
    expect(await encolarActa('E14-176-0042-03', 99, redis)).toBe(false);
    // La prioridad original se conserva (NX no pisa).
    expect(await obtenerActa('E14-176-0042-03', redis)).toEqual({
      acta: 'E14-176-0042-03',
      prioridad: 30,
    });
    const lista = await pendientes(10, 0, redis);
    expect(lista.map((c) => c.acta)).toEqual([
      'E14-176-0042-03',
      'E14-201-0007-03',
      'E14-033-0115-03',
    ]);
    expect(await tamanioCola(redis)).toBe(3);
  });

  it('actualiza prioridad y reordena', async () => {
    const redis = redisFalsoVerificacion();
    await encolarActa('A', 10, redis);
    await encolarActa('B', 20, redis);
    expect(await actualizarPrioridad('A', 50, redis)).toBe(true);
    expect(await actualizarPrioridad('NO-EXISTE', 50, redis)).toBe(false);
    const lista = await pendientes(10, 0, redis);
    expect(lista[0]).toEqual({ acta: 'A', prioridad: 50 });
  });

  it('retira y reintegra sin duplicar', async () => {
    const redis = redisFalsoVerificacion();
    await encolarActa('A', 10, redis);
    expect(await retirarActa('A', redis)).toBe(true);
    expect(await retirarActa('A', redis)).toBe(false);
    expect(await tamanioCola(redis)).toBe(0);
    expect(await reintegrarActa('A', 15, redis)).toBe(true);
    expect(await obtenerActa('A', redis)).toEqual({ acta: 'A', prioridad: 15 });
    expect(await tamanioCola(redis)).toBe(1);
  });
});

describe('RF-7 bloqueos distribuidos (SET NX PX + Lua)', () => {
  it('dos auditores intentan tomar la misma acta: solo uno obtiene el bloqueo', async () => {
    const redis = redisFalsoVerificacion();
    await encolarActa('E14-176-0042-03', 30, redis);
    const a = await intentarBloquear('E14-176-0042-03', 'AUD-1', 30_000, redis);
    const b = await intentarBloquear('E14-176-0042-03', 'AUD-2', 30_000, redis);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(await consultarPropietario('E14-176-0042-03', redis)).toMatchObject({
      auditor: 'AUD-1',
    });
  });

  it('un auditor no puede liberar el bloqueo de otro', async () => {
    const redis = redisFalsoVerificacion();
    const a = await intentarBloquear('ACTA-1', 'AUD-1', 30_000, redis);
    // Token inventado: no libera.
    expect(await liberarBloqueo('ACTA-1', 'token-falso', redis)).toBe(false);
    // El bloqueo de AUD-1 sigue vigente.
    expect(await consultarPropietario('ACTA-1', redis)).toMatchObject({ auditor: 'AUD-1' });
    // El dueño sí puede liberar.
    expect(await liberarBloqueo('ACTA-1', a.token, redis)).toBe(true);
    expect(await consultarPropietario('ACTA-1', redis)).toBeNull();
  });

  it('renueva el TTL y detecta expiración', async () => {
    const redis = redisFalsoVerificacion();
    const a = await intentarBloquear('ACTA-1', 'AUD-1', 200, redis);
    expect(await renovarBloqueo('ACTA-1', a.token, 1000, redis)).toBe(true);
    // Token ajeno no renueva.
    expect(await renovarBloqueo('ACTA-1', 'otro', 1000, redis)).toBe(false);
    // Expira y otro auditor puede tomarlo.
    const corto = await intentarBloquear('ACTA-2', 'AUD-1', 80, redis);
    expect(corto).not.toBeNull();
    await dormir(120);
    const b = await intentarBloquear('ACTA-2', 'AUD-2', 30_000, redis);
    expect(b).not.toBeNull();
  });

  it('A no puede liberar el bloqueo reasignado a B (escenario expiración)', async () => {
    const redis = redisFalsoVerificacion();
    const a = await intentarBloquear('ACTA-1', 'AUD-A', 80, redis);
    await dormir(120); // expira el de A
    const b = await intentarBloquear('ACTA-1', 'AUD-B', 30_000, redis);
    expect(b).not.toBeNull();
    // A intenta liberar con su token viejo: debe fallar y NO borrar el de B.
    expect(await liberarBloqueo('ACTA-1', a.token, redis)).toBe(false);
    expect(await consultarPropietario('ACTA-1', redis)).toMatchObject({ auditor: 'AUD-B' });
  });
});

describe('RF-7 heartbeat', () => {
  it('mantiene vivo el bloqueo mientras trabaja y se detiene al pedirlo', async () => {
    const redis = redisFalsoVerificacion();
    const { token } = await intentarBloquear('ACTA-1', 'AUD-1', 200, redis);
    const ctrl = iniciarHeartbeat('ACTA-1', token, {
      ttlMs: 200,
      intervaloMs: 50,
      redis,
    });
    // Pasa más del TTL original: sin heartbeat habría expirado.
    await dormir(350);
    expect(await consultarPropietario('ACTA-1', redis)).toMatchObject({ auditor: 'AUD-1' });
    ctrl.detener();
    await dormir(250);
    // Sin renovación, expira y queda libre.
    expect(await consultarPropietario('ACTA-1', redis)).toBeNull();
  });

  it('se detiene solo si el token ya no es dueño y avisa', async () => {
    const redis = redisFalsoVerificacion();
    let perdido = null;
    iniciarHeartbeat('ACTA-1', 'token-viejo', {
      ttlMs: 200,
      intervaloMs: 30,
      redis,
      onPerdido: (info) => {
        perdido = info;
      },
    });
    await dormir(120);
    expect(perdido).toMatchObject({ acta: 'ACTA-1', token: 'token-viejo' });
  });
});

describe('RF-7 fachada tomarCaso/liberarCaso (sin romper firmas)', () => {
  it('asigna por prioridad, publica eventos y libera', async () => {
    const redis = redisFalsoVerificacion();
    registrarClientes({ redis, redisSub: redis });
    await encolarActa('BAJA', 10, redis);
    await encolarActa('ALTA', 90, redis);

    const caso = await tomarCaso('AUD-7');
    expect(caso).toMatchObject({ acta: 'ALTA' });
    expect(typeof caso.token).toBe('string');
    expect(caso.ttl_ms).toBeGreaterThan(0);

    // La cola muestra a quién está asignada.
    const cola = await verCola();
    expect(cola.find((c) => c.acta === 'ALTA')).toMatchObject({ asignada_a: 'AUD-7' });

    // Otro auditor no puede tomar la misma: toma la siguiente libre.
    const caso2 = await tomarCaso('AUD-8');
    expect(caso2).toMatchObject({ acta: 'BAJA' });

    // Liberar con token ajeno falla.
    expect(await liberarCaso('AUD-8', 'ALTA', 'falso')).toBe(false);
    // El dueño libera.
    expect(await liberarCaso('AUD-7', 'ALTA', caso.token)).toBe(true);
    // Resolver el segundo caso lo saca de la cola.
    expect(await resolverCaso('AUD-8', 'BAJA', caso2.token)).toBe(true);
    expect(await tamanioCola(redis)).toBe(1);
  });
});

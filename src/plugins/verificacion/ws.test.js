// Dueño: Persona 3. Tests de los WS de jurados y auditores (RT-5, RF-7, RF-8).
// Usan el WebSocket global de Node 22 (sin dependencias nuevas) contra 1-2
// instancias reales escuchando en puertos efímeros, con un backplane falso
// compartido (mismo store + Pub/Sub) para probar difusión entre instancias.
import { afterAll, describe, expect, it } from 'vitest';
import { construirApp } from '../../server.js';
import { ACTA_EJEMPLO, CONFIG_TEST } from '../../../test/helpers.js';
import { encolarActa, tamanioCola } from '../../verificacion/cola.js';
import { verCola } from '../../verificacion/index.js';

/** Cluster Redis falso compartido: mismo store + Pub/Sub entre pares. */
function crearClusterFalso() {
  const zsets = new Map();
  const strings = new Map();
  const manejadores = new Set();

  function vigente(key) {
    const e = strings.get(key);
    if (!e) return null;
    if (e.expiraMs !== null && Date.now() >= e.expiraMs) {
      strings.delete(key);
      return null;
    }
    return e;
  }

  function tokenOk(crudo, token) {
    if (crudo.startsWith('{')) {
      try {
        return JSON.parse(crudo).token === token;
      } catch {
        return false;
      }
    }
    return crudo === token;
  }

  function base() {
    return {
      status: 'ready',
      on() {
        return this;
      },
      async ping() {
        return 'PONG';
      },
      async quit() {
        return 'OK';
      },
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
        const reb = orden.slice(start, stop + 1);
        if (String(withscores).toUpperCase() === 'WITHSCORES') {
          return reb.flatMap(([member, score]) => [member, String(score)]);
        }
        return reb.map(([member]) => member);
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
        let ms = null;
        for (let i = 0; i < args.length; i++) {
          const a = String(args[i]).toUpperCase();
          if (a === 'NX') nx = true;
          else if (a === 'PX') ms = Number(args[++i]);
          else if (a === 'EX') ms = Number(args[++i]) * 1000;
        }
        if (nx && vigente(key)) return null;
        strings.set(key, { valor: String(valor), expiraMs: ms ? Date.now() + ms : null });
        return 'OK';
      },
      async get(key) {
        return vigente(key)?.valor ?? null;
      },
      async exists(key) {
        return vigente(key) ? 1 : 0;
      },
      async del(key) {
        return strings.delete(key) ? 1 : 0;
      },
      async eval(script, numkeys, ...args) {
        const keys = args.slice(0, numkeys);
        const argv = args.slice(numkeys);
        const e = vigente(keys[0]);
        if (script.includes('PEXPIRE')) {
          const [token, ttl] = argv;
          if (!e || !tokenOk(e.valor, token)) return 0;
          e.expiraMs = Date.now() + Number(ttl);
          return 1;
        }
        const [token] = argv;
        if (!e || !tokenOk(e.valor, token)) return 0;
        strings.delete(keys[0]);
        return 1;
      },
      async scan(_cursor, ...args) {
        let match = '*';
        for (let i = 0; i < args.length; i++) {
          if (String(args[i]).toUpperCase() === 'MATCH') match = args[++i];
        }
        const rx = new RegExp(
          `^${match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
        );
        return ['0', [...strings.keys()].filter((k) => rx.test(k) && vigente(k))];
      },
      async publish(canal, mensaje) {
        const texto = typeof mensaje === 'string' ? mensaje : JSON.stringify(mensaje);
        for (const h of [...manejadores]) setImmediate(() => h(canal, texto));
        return 1;
      },
    };
  }

  return {
    nuevoPar() {
      const redis = base();
      const redisSub = base();
      redisSub.subscribe = async () => 1;
      redisSub.on = (evento, fn) => {
        if (evento === 'message') manejadores.add(fn);
        return redisSub;
      };
      return { redis, redisSub };
    },
  };
}

/** Redis mínimo para el WS de jurados (el dominio P1 es stub en memoria). */
function redisMinimo() {
  return {
    status: 'ready',
    on() {
      return this;
    },
    async ping() {
      return 'PONG';
    },
    async quit() {
      return 'OK';
    },
    async publish() {
      return 1;
    },
    async subscribe() {
      return 1;
    },
  };
}

/** Conecta un cliente WS y devuelve el socket con buzón por tipo. */
async function conectar(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cola = [];
  const esperas = [];
  ws.addEventListener('message', async (ev) => {
    const texto = typeof ev.data === 'string' ? ev.data : await ev.data.text();
    let msg;
    try {
      msg = JSON.parse(texto);
    } catch {
      return;
    }
    const i = esperas.findIndex((p) => !p.tipo || p.tipo === msg.tipo);
    if (i >= 0) {
      const [p] = esperas.splice(i, 1);
      clearTimeout(p.t);
      p.res(msg);
    } else {
      cola.push(msg);
    }
  });
  return {
    ws,
    proximo(tipo, ms = 5000) {
      const i = cola.findIndex((m) => !tipo || m.tipo === tipo);
      if (i >= 0) return Promise.resolve(cola.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const t = setTimeout(() => {
          const j = esperas.findIndex((p) => p.res === res);
          if (j >= 0) esperas.splice(j, 1);
          rej(new Error(`timeout esperando mensaje tipo=${tipo}`));
        }, ms);
        esperas.push({ tipo, res, t });
      });
    },
    cerrar() {
      try {
        ws.close();
      } catch {
        /* ya cerrado */
      }
    },
  };
}

const urlBase = (app) => `ws://127.0.0.1:${app.server.address().port}`;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const actaDe = (idem, jurado = ACTA_EJEMPLO.jurado) => ({ ...ACTA_EJEMPLO, idem, jurado });

// ── WS jurados (RT-5: bidireccional; ACK solo tras registrarActa) ──

describe('WS /ws/jurado', () => {
  let app;
  const clientes = [];

  afterAll(async () => {
    for (const c of clientes) c.cerrar();
    await app?.close().catch(() => null);
  });

  it('hola + acta válida → ACK con respuesta registrada', async () => {
    const r = redisMinimo();
    app = await construirApp({ config: { ...CONFIG_TEST }, redis: r, redisSub: r, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const c = await conectar(`${urlBase(app)}/ws/jurado?jurado=${ACTA_EJEMPLO.jurado}`);
    clientes.push(c);
    expect(await c.proximo('hola')).toMatchObject({ instancia: 'test-1' });
    c.ws.send(JSON.stringify({ tipo: 'acta', acta: actaDe('ws-jurado-0001') }));
    const resp = await c.proximo('respuesta');
    expect(resp.respuesta).toMatchObject({ estado: 'registrada' });
    expect(resp.respuesta.recibo).toBeTruthy();
  });

  it('reenvío con el mismo idem → duplicada (idempotencia de P1)', async () => {
    const c = await conectar(`${urlBase(app)}/ws/jurado?jurado=${ACTA_EJEMPLO.jurado}`);
    clientes.push(c);
    await c.proximo('hola');
    const acta = actaDe('ws-jurado-dupe');
    c.ws.send(JSON.stringify({ tipo: 'acta', acta }));
    const r1 = await c.proximo('respuesta');
    c.ws.send(JSON.stringify({ tipo: 'acta', acta }));
    const r2 = await c.proximo('respuesta');
    expect(r1.respuesta.estado).toBe('registrada');
    expect(r2.respuesta).toMatchObject({ estado: 'duplicada', recibo: r1.respuesta.recibo });
  });

  it('rechaza acta inválida, jurado ajeno, json y tipos desconocidos', async () => {
    const c = await conectar(`${urlBase(app)}/ws/jurado?jurado=${ACTA_EJEMPLO.jurado}`);
    clientes.push(c);
    await c.proximo('hola');
    c.ws.send(
      JSON.stringify({ tipo: 'acta', acta: { ...actaDe('ws-jurado-bad'), votos: undefined } }),
    );
    expect(await c.proximo('error')).toMatchObject({ motivo: 'acta_invalida' });
    c.ws.send(JSON.stringify({ tipo: 'acta', acta: actaDe('ws-jurado-otro', 'JUR-IMPOSTOR') }));
    expect(await c.proximo('error')).toMatchObject({ motivo: 'jurado_no_coincide' });
    c.ws.send('esto no es json{');
    expect(await c.proximo('error')).toMatchObject({ motivo: 'json_invalido' });
    c.ws.send(JSON.stringify({ tipo: 'magia' }));
    expect(await c.proximo('error')).toMatchObject({ motivo: 'tipo_desconocido' });
  });

  it('mensaje gigante se rechaza y se cierra', async () => {
    const c = await conectar(`${urlBase(app)}/ws/jurado?jurado=${ACTA_EJEMPLO.jurado}`);
    clientes.push(c);
    await c.proximo('hola');
    const cierre = new Promise((res) => c.ws.addEventListener('close', res, { once: true }));
    c.ws.send(`{"tipo":"acta","relleno":"${'x'.repeat(70 * 1024)}"}`);
    expect(await c.proximo('error')).toMatchObject({ motivo: 'mensaje_muy_grande' });
    await cierre;
  });
});

// ── WS auditores (RF-7 colaborativo + RF-8 presencia, 2 instancias) ──

describe('WS /ws/auditor', () => {
  const cluster = crearClusterFalso();
  const par1 = cluster.nuevoPar();
  const par2 = cluster.nuevoPar();
  let app1;
  let app2;
  const clientes = [];
  let n = 0;
  const actaUnica = (base) => `F3-${base}-${++n}`;

  afterAll(async () => {
    for (const c of clientes) c.cerrar();
    await dormir(50);
    await app1?.close().catch(() => null);
    await app2?.close().catch(() => null);
  });

  it('sin ?auditor= se rechaza con 4001', async () => {
    app1 = await construirApp({
      config: { ...CONFIG_TEST, instanceId: 'test-1' },
      ...par1,
      logger: false,
    });
    await app1.listen({ port: 0, host: '127.0.0.1' });
    app2 = await construirApp({
      config: { ...CONFIG_TEST, instanceId: 'test-2' },
      ...par2,
      logger: false,
    });
    await app2.listen({ port: 0, host: '127.0.0.1' });

    const ws = new WebSocket(`${urlBase(app1)}/ws/auditor`);
    const error = await new Promise((res, rej) => {
      ws.addEventListener('message', async (ev) => {
        const t = typeof ev.data === 'string' ? ev.data : await ev.data.text();
        res(JSON.parse(t));
      });
      ws.addEventListener('error', rej);
    });
    const codigo = await new Promise((res) => ws.addEventListener('close', (ev) => res(ev.code)));
    expect(error).toMatchObject({ tipo: 'error', motivo: 'falta_auditor' });
    expect(codigo).toBe(4001);
  });

  it('hola trae cola y presentes; tomar asigna la de mayor prioridad', async () => {
    const acta = actaUnica('TOMAR');
    await encolarActa(acta, 5000, par1.redis);
    const c = await conectar(`${urlBase(app1)}/ws/auditor?auditor=AUD-T1`);
    clientes.push(c);
    const hola = await c.proximo('hola');
    expect(hola.instancia).toBe('test-1');
    expect(hola.cola.map((x) => x.acta)).toContain(acta);
    expect(hola.presentes.map((p) => p.auditor)).toContain('AUD-T1');
    c.ws.send(JSON.stringify({ tipo: 'tomar' }));
    const caso = await c.proximo('caso');
    expect(caso.caso).toMatchObject({ acta });
    c.ws.send(JSON.stringify({ tipo: 'liberar', acta: caso.caso.acta, token: caso.caso.token }));
    expect(await c.proximo('liberado')).toMatchObject({ acta, ok: true });
  });

  it('dos auditores toman actas distintas; token ajeno no libera', async () => {
    const alta = actaUnica('ALTA');
    const media = actaUnica('MEDIA');
    await encolarActa(alta, 6001, par1.redis);
    await encolarActa(media, 6000, par1.redis);
    const a = await conectar(`${urlBase(app1)}/ws/auditor?auditor=AUD-T2`);
    const b = await conectar(`${urlBase(app2)}/ws/auditor?auditor=AUD-T3`);
    clientes.push(a, b);
    await a.proximo('hola');
    await b.proximo('hola');
    a.ws.send(JSON.stringify({ tipo: 'tomar' }));
    b.ws.send(JSON.stringify({ tipo: 'tomar' }));
    const ca = await a.proximo('caso');
    const cb = await b.proximo('caso');
    expect(ca.caso.acta).toBe(alta);
    expect(cb.caso.acta).toBe(media);
    // Token inventado no libera lo de otro.
    a.ws.send(JSON.stringify({ tipo: 'liberar', acta: cb.caso.acta, token: 'falso' }));
    expect(await a.proximo('liberado')).toMatchObject({ ok: false });
    // Cada dueño libera lo suyo.
    a.ws.send(JSON.stringify({ tipo: 'liberar', acta: ca.caso.acta, token: ca.caso.token }));
    b.ws.send(JSON.stringify({ tipo: 'liberar', acta: cb.caso.acta, token: cb.caso.token }));
    expect(await a.proximo('liberado')).toMatchObject({ ok: true });
    expect(await b.proximo('liberado')).toMatchObject({ ok: true });
  });

  it('ya_tienes_caso, latido_ok y snapshots de cola/presentes', async () => {
    const acta = actaUnica('YA');
    await encolarActa(acta, 7000, par1.redis);
    const c = await conectar(`${urlBase(app1)}/ws/auditor?auditor=AUD-T4`);
    clientes.push(c);
    await c.proximo('hola');
    c.ws.send(JSON.stringify({ tipo: 'tomar' }));
    const caso = await c.proximo('caso');
    expect(caso.caso.acta).toBe(acta);
    c.ws.send(JSON.stringify({ tipo: 'tomar' }));
    expect(await c.proximo('error')).toMatchObject({ motivo: 'ya_tienes_caso', acta });
    c.ws.send(JSON.stringify({ tipo: 'latido', acta }));
    expect(await c.proximo('latido_ok')).toBeTruthy();
    c.ws.send(JSON.stringify({ tipo: 'cola' }));
    expect((await c.proximo('cola')).cola.map((x) => x.acta)).toContain(acta);
    c.ws.send(JSON.stringify({ tipo: 'presentes' }));
    expect((await c.proximo('presentes')).presentes.map((p) => p.auditor)).toContain('AUD-T4');
    c.ws.send(JSON.stringify({ tipo: 'liberar', acta, token: caso.caso.token }));
    expect(await c.proximo('liberado')).toMatchObject({ ok: true });
  });

  it('completar resuelve y saca el acta de la cola', async () => {
    const acta = actaUnica('COMP');
    await encolarActa(acta, 8000, par1.redis);
    const antes = await tamanioCola(par1.redis);
    const c = await conectar(`${urlBase(app1)}/ws/auditor?auditor=AUD-T5`);
    clientes.push(c);
    await c.proximo('hola');
    c.ws.send(JSON.stringify({ tipo: 'tomar' }));
    const caso = await c.proximo('caso');
    expect(caso.caso.acta).toBe(acta);
    c.ws.send(JSON.stringify({ tipo: 'completar', acta, token: caso.caso.token }));
    expect(await c.proximo('completado')).toMatchObject({ acta, ok: true });
    expect(await tamanioCola(par1.redis)).toBe(antes - 1);
    expect((await verCola()).map((x) => x.acta)).not.toContain(acta);
  });

  it('lo tomado en la instancia 1 se difunde a la consola de la instancia 2', async () => {
    const acta = actaUnica('BC');
    await encolarActa(acta, 9000, par1.redis);
    const b = await conectar(`${urlBase(app2)}/ws/auditor?auditor=AUD-T6`);
    clientes.push(b);
    await b.proximo('hola');
    const a = await conectar(`${urlBase(app1)}/ws/auditor?auditor=AUD-T7`);
    clientes.push(a);
    await a.proximo('hola');
    a.ws.send(JSON.stringify({ tipo: 'tomar' }));
    const caso = await a.proximo('caso');
    expect(caso.caso.acta).toBe(acta);
    // La otra instancia recibe la actualización de cola por el backplane.
    const aviso = await b.proximo('cola', 8000);
    expect(aviso.evento).toMatchObject({ tipo: 'asignada', acta });
    expect(aviso.cola.find((x) => x.acta === acta)).toMatchObject({ asignada_a: 'AUD-T7' });
    a.ws.send(JSON.stringify({ tipo: 'liberar', acta, token: caso.caso.token }));
    expect(await a.proximo('liberado')).toMatchObject({ ok: true });
  });
});

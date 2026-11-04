// Dueño: Persona 1. Simula la jornada completa sobre el catálogo sintético (6.400 mesas):
//   - 55 % de las actas en los primeros 40 min de una ventana de 2 h, con ráfagas
//   - ~7,5 % dudosas (no cuadran), ~8 % de reenvíos (mismo idem) y ~1 % con idem nuevo
//   - ~180 correcciones (v2, algunas v3), parte de ellas fuera de orden
// Al final compara el acumulado departamental con el esperado y, con MEDIR=1, mide la memoria
// de cada estructura con MEMORY USAGE.
//
//   MODO=directo  → llama al registro sobre Redis sin HTTP (rápido; para medir memoria).
//   MODO=http     → POST /actas contra URL (p. ej. nginx con 8 réplicas).
//
//   LIMPIAR=1 MEDIR=1 REDIS_URL=redis://localhost:6379/5 node scripts/simular-actas.js
//   MODO=http URL=http://localhost:8080 VELOCIDAD=120 node scripts/simular-actas.js
//
// VELOCIDAD: 0 = sin esperas (lo más rápido posible); N = la jornada de 2 h dura 2h/N.
import { Redis } from 'ioredis';
import { generarCatalogo, prng, sembrarCatalogo } from '../src/dominio/catalogo.js';
import { registrar } from '../src/redis/actas.js';
import { definirComandos } from '../src/redis/scripts.js';
import * as K from '../src/contratos/keys.js';

const MODO = process.env.MODO ?? 'directo';
const URL_APP = process.env.URL ?? 'http://localhost:8080';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const SEMILLA = Number(process.env.SEMILLA ?? 2026);
const VELOCIDAD = Number(process.env.VELOCIDAD ?? 0);
const CONCURRENCIA = Number(process.env.CONCURRENCIA ?? 16);
const CANDIDATOS = Number(process.env.CANDIDATOS ?? 5);
const P_DUDOSA = 0.075;
const P_REENVIO = 0.08;
const P_IDEM_NUEVO = 0.01;
const CORRECCIONES = 180;
const JORNADA_MS = 2 * 60 * 60 * 1000;

const azar = prng(SEMILLA + 1);
const entre = (min, max) => min + Math.floor(azar() * (max - min + 1));
const idem = () =>
  Math.floor(azar() * 2 ** 52)
    .toString(16)
    .padStart(14, '0');

// ───────────────────────── generación del plan de envíos ─────────────────────────
function generarVotos(cuadra) {
  const votos = {};
  for (let c = 1; c <= CANDIDATOS; c++) votos[`C${c}`] = entre(20, 180);
  votos.BLANCO = entre(0, 25);
  votos.NULO = entre(0, 12);
  votos.NO_MARCADO = entre(0, 6);
  const suma = Object.values(votos).reduce((a, b) => a + b, 0);
  return { votos, sufragantes: cuadra ? suma : suma + entre(1, 9) };
}

/** Minuto de cierre: 55 % en los primeros 40 min, ráfagas en los minutos 10–15 y 25–28. */
function tiempoDeCierre() {
  const r = azar();
  if (r < 0.15) return entre(10 * 60e3, 15 * 60e3);
  if (r < 0.22) return entre(25 * 60e3, 28 * 60e3);
  if (r < 0.55) return entre(0, 40 * 60e3);
  return entre(40 * 60e3, JORNADA_MS);
}

function planDeLaJornada(cat) {
  const envios = [];
  const ultima = new Map(); // acta → mensaje más reciente (para corregir)
  for (const [mesa, { puesto, municipio }] of cat.mesa) {
    const { votos, sufragantes } = generarVotos(azar() >= P_DUDOSA);
    const a = {
      acta: `E14-${puesto}-${mesa}-03`,
      mesa,
      puesto,
      municipio,
      version: 1,
      jurado: `JUR-${mesa}`,
      ts_cierre: 1793577600,
      votos,
      sufragantes,
      hash_foto: idem(),
      idem: idem(),
    };
    const t = tiempoDeCierre();
    envios.push({ t, acta: a, tipo: 'nueva' });
    ultima.set(a.acta, { a, t });
    if (azar() < P_REENVIO) envios.push({ t: t + entre(5e3, 180e3), acta: a, tipo: 'reenvio' });
    if (azar() < P_IDEM_NUEVO) {
      envios.push({ t: t + entre(60e3, 600e3), acta: { ...a, idem: idem() }, tipo: 'idem_nuevo' });
    }
  }
  // Correcciones: v2 (y ~10 % también v3). Un 30 % llega ANTES que la versión anterior.
  const actas = [...ultima.values()];
  for (let i = 0; i < CORRECCIONES; i++) {
    const { a, t } = actas[entre(0, actas.length - 1)];
    const previa = ultima.get(a.acta).a;
    const corr = { ...previa, ...generarVotos(true), version: previa.version + 1, idem: idem() };
    const desorden = azar() < 0.3;
    envios.push({
      t: desorden ? Math.max(0, t - entre(1e3, 30e3)) : t + entre(5 * 60e3, 60 * 60e3),
      acta: corr,
      tipo: 'correccion',
    });
    ultima.set(a.acta, { a: corr, t });
  }
  envios.sort((x, y) => x.t - y.t);
  return envios;
}

/** Departamento esperado: por acta, la versión VÁLIDA más alta enviada (las dudosas no suman). */
function esperado(envios) {
  const mejor = new Map();
  for (const { acta: a } of envios) {
    const suma = Object.values(a.votos).reduce((x, y) => x + y, 0);
    if (suma !== a.sufragantes) continue;
    const prev = mejor.get(a.acta);
    if (!prev || a.version > prev.version) mejor.set(a.acta, a);
  }
  const dep = { informadas: mejor.size, sufragantes: 0 };
  for (const a of mejor.values()) {
    dep.sufragantes += a.sufragantes;
    for (const [k, v] of Object.entries(a.votos)) dep[k] = (dep[k] ?? 0) + v;
  }
  return dep;
}

// ───────────────────────── ejecución ─────────────────────────
async function ejecutar(envios, enviar) {
  const estados = {};
  const instancias = {};
  let i = 0;
  const t0 = Date.now();
  const inicio = performance.now();
  async function trabajador() {
    while (i < envios.length) {
      const e = envios[i++];
      if (VELOCIDAD > 0) {
        const espera = e.t / VELOCIDAD - (Date.now() - t0);
        if (espera > 0) await new Promise((r) => setTimeout(r, espera));
      }
      const { estado, instancia } = await enviar(e.acta);
      estados[estado] = (estados[estado] ?? 0) + 1;
      if (instancia) instancias[instancia] = (instancias[instancia] ?? 0) + 1;
      if (i % 1000 === 0) process.stdout.write(`  ${i}/${envios.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));
  return { estados, instancias, ms: performance.now() - inicio };
}

function enviarDirecto(redis) {
  return async (acta) => ({ estado: (await registrar(redis, acta, { instancia: 'sim' })).estado });
}

function enviarHttp(acta) {
  return fetch(`${URL_APP}/actas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(acta),
  })
    .then(async (res) => ({
      estado:
        res.status === 429
          ? 'http_429'
          : res.status === 503
            ? 'http_503'
            : (await res.json()).estado,
      instancia: res.headers.get('x-instance-id'),
    }))
    .catch(() => ({ estado: 'error_red' }));
}

// ───────────────────────── medición de memoria ─────────────────────────
const CATEGORIAS = [
  ['acta:*:versiones', /^acta:.*:versiones$/],
  ['acta:*', /^acta:/],
  ['idem:*', /^idem:/],
  ['acum:mesa:*', /^acum:mesa:/],
  ['acum:pue:*', /^acum:pue:/],
  ['acum:mun:*', /^acum:mun:/],
  ['acum:dep', /^acum:dep$/],
  ['rank:*', /^rank:/],
  ['cat:*', /^cat:/],
  ['stream:actas', /^stream:actas$/],
  ['cola:verificacion', /^cola:verificacion$/],
  ['rl:*', /^rl:/],
];

async function medirMemoria(redis) {
  const filas = new Map(CATEGORIAS.map(([n]) => [n, { claves: 0, bytes: 0 }]));
  let cursor = '0';
  do {
    const [sig, claves] = await redis.scan(cursor, 'COUNT', 1000);
    cursor = sig;
    const p = redis.pipeline();
    for (const k of claves) p.call('MEMORY', 'USAGE', k, 'SAMPLES', '0');
    const usos = await p.exec();
    claves.forEach((k, j) => {
      const cat = CATEGORIAS.find(([, re]) => re.test(k))?.[0] ?? 'otras';
      if (!filas.has(cat)) filas.set(cat, { claves: 0, bytes: 0 });
      const f = filas.get(cat);
      f.claves++;
      f.bytes += Number(usos[j][1] ?? 0);
    });
  } while (cursor !== '0');
  const info = await redis.info('memory');
  const usada = Number(/used_memory:(\d+)/.exec(info)[1]);
  return { filas, usada };
}

const kb = (b) => (b / 1024).toFixed(1);

// ───────────────────────── main ─────────────────────────
const cat = generarCatalogo(SEMILLA);
const envios = planDeLaJornada(cat);
const cuenta = envios.reduce((m, e) => ((m[e.tipo] = (m[e.tipo] ?? 0) + 1), m), {});
console.log(`[simular-actas] ${envios.length} envíos (${JSON.stringify(cuenta)}), modo ${MODO}`);

const redis = definirComandos(new Redis(REDIS_URL));
try {
  if (process.env.LIMPIAR === '1') {
    await redis.flushdb();
    console.log(`  base vaciada (${REDIS_URL})`);
  }
  await sembrarCatalogo(redis, SEMILLA);

  const r = await ejecutar(envios, MODO === 'http' ? enviarHttp : enviarDirecto(redis));
  console.log(`\nEstados: ${JSON.stringify(r.estados)}`);
  if (MODO === 'http') console.log(`Por instancia: ${JSON.stringify(r.instancias)}`);
  console.log(
    `Duración: ${(r.ms / 1000).toFixed(1)} s (${Math.round(envios.length / (r.ms / 1000))} envíos/s)`,
  );

  const esp = esperado(envios);
  const real = await redis.hgetall(K.acum('dep'));
  const campos = Object.keys(esp);
  const difs = campos.filter((k) => Number(real[k] ?? 0) !== esp[k]);
  console.log(
    difs.length === 0
      ? `Acumulado departamental CONSISTENTE con el esperado (${esp.informadas} mesas informadas).`
      : `DIFERENCIAS en ${difs.join(', ')}: esperado ${JSON.stringify(esp)} real ${JSON.stringify(real)}`,
  );
  console.log(
    `Cola de verificación: ${await redis.zcard(K.colaVerificacion)} actas dudosas pendientes.`,
  );

  if (process.env.MEDIR === '1') {
    const { filas, usada } = await medirMemoria(redis);
    console.log('\n| Estructura | Claves | Memoria (KB) | Bytes/clave |');
    console.log('| --- | ---: | ---: | ---: |');
    let total = 0;
    for (const [n, f] of filas) {
      if (!f.claves) continue;
      total += f.bytes;
      console.log(
        `| \`${n}\` | ${f.claves} | ${kb(f.bytes)} | ${Math.round(f.bytes / f.claves)} |`,
      );
    }
    console.log(`| **Total (MEMORY USAGE)** | | **${kb(total)}** | |`);
    console.log(`\nused_memory del servidor: ${(usada / 1024 / 1024).toFixed(2)} MB`);
    console.log(`stream:actas: ${await redis.xlen(K.streamActas)} entradas`);
  }
} finally {
  await redis.quit();
}

// Jurado falso: envía actas a POST /actas con reenvíos (mismo idem), correcciones (version+1,
// idem nuevo) y alguna acta que no cuadra (dudosa). Al final imprime estados e instancias.
//   npm run jurado:falso                                  (http://localhost:3000, 50 actas)
//   URL=http://localhost:8080 N=200 INTERVALO_MS=50 npm run jurado:falso
import { randomBytes } from 'node:crypto';
import { ActaEntrante } from '../src/contratos/esquemas.js';

const URL_BASE = process.env.URL ?? 'http://localhost:3000';
const N = Number(process.env.N ?? 50);
const INTERVALO = Number(process.env.INTERVALO_MS ?? 100);
const P_REENVIO = 0.1;
const P_CORRECCION = 0.03;
const P_DUDOSA = 0.07;

const azar = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const idem = () => randomBytes(8).toString('hex');

function votosAlAzar() {
  return {
    C1: azar(50, 300),
    C2: azar(50, 300),
    C3: azar(50, 300),
    BLANCO: azar(0, 30),
    NULO: azar(0, 15),
    NO_MARCADO: azar(0, 8),
  };
}

function nuevaActa() {
  const puesto = azar(1, 1842);
  const mesa = azar(1, 6400);
  const votos = votosAlAzar();
  let sufragantes = Object.values(votos).reduce((a, b) => a + b, 0);
  if (Math.random() < P_DUDOSA) sufragantes += azar(1, 5); // no cuadra → dudosa
  return ActaEntrante.parse({
    acta: `E14-${String(puesto).padStart(3, '0')}-${String(mesa).padStart(4, '0')}-03`,
    mesa,
    puesto,
    municipio: azar(1, 20),
    version: 1,
    jurado: `JUR-${azar(10000, 99999)}`,
    ts_cierre: Math.floor(Date.now() / 1000),
    votos,
    sufragantes,
    hash_foto: randomBytes(16).toString('hex'),
    idem: idem(),
  });
}

function corregir(acta) {
  const votos = votosAlAzar();
  const sufragantes = Object.values(votos).reduce((a, b) => a + b, 0);
  return { ...acta, version: acta.version + 1, votos, sufragantes, idem: idem() };
}

const estados = {};
const instancias = {};
const enviadas = [];

async function enviar(acta, etiqueta) {
  try {
    const res = await fetch(`${URL_BASE}/actas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(acta),
    });
    const cuerpo = await res.json();
    const inst = res.headers.get('x-instance-id') ?? '?';
    estados[cuerpo.estado] = (estados[cuerpo.estado] ?? 0) + 1;
    instancias[inst] = (instancias[inst] ?? 0) + 1;
    console.log(
      `${etiqueta.padEnd(10)} ${acta.acta} v${acta.version} → ${res.status} ${cuerpo.estado} [${inst}]`,
    );
  } catch (e) {
    estados.error_red = (estados.error_red ?? 0) + 1;
    console.log(`${etiqueta.padEnd(10)} ${acta.acta} → error de red: ${e.message}`);
  }
}

console.log(`[jurado-falso] ${N} actas contra ${URL_BASE}`);
for (let i = 0; i < N; i++) {
  const r = Math.random();
  if (enviadas.length && r < P_REENVIO) {
    await enviar(enviadas[azar(0, enviadas.length - 1)], 'reenvio');
  } else if (enviadas.length && r < P_REENVIO + P_CORRECCION) {
    const j = azar(0, enviadas.length - 1);
    enviadas[j] = corregir(enviadas[j]);
    await enviar(enviadas[j], 'correccion');
  } else {
    const acta = nuevaActa();
    enviadas.push(acta);
    await enviar(acta, 'nueva');
  }
  await pausa(INTERVALO);
}

console.log('\nEstados:', estados);
console.log('Respuestas por instancia:', instancias);

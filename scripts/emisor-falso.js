// Emisor falso: cada segundo agrega un EventoActaNueva válido a stream:actas y lo publica en
// el canal acta:nueva. Sirve para que Persona 2 pruebe el fan-out sin esperar a Persona 1.
//   npm run emisor:falso            (usa REDIS_URL o redis://localhost:6379)
//   INTERVALO_MS=200 npm run emisor:falso
import { Redis } from 'ioredis';
import { CANALES } from '../src/contratos/canales.js';
import { EventoActaNueva } from '../src/contratos/esquemas.js';
import { streamActas } from '../src/contratos/keys.js';
import { camposStream } from '../src/contratos/stream.js';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const intervalo = Number(process.env.INTERVALO_MS ?? 1000);
const MAXLEN = 10_000;

const redis = new Redis(url);
const azar = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const versiones = new Map(); // acta → última versión emitida
let emitidos = 0;

function siguienteEvento() {
  // ~3 % de las veces corrige un acta ya emitida.
  if (versiones.size > 0 && Math.random() < 0.03) {
    const actas = [...versiones.keys()];
    const acta = actas[azar(0, actas.length - 1)];
    const version = versiones.get(acta) + 1;
    versiones.set(acta, version);
    const [, pue] = acta.split('-');
    return { acta, mun: azar(1, 20), pue: Number(pue), version, tipo: 'correccion' };
  }
  const pue = azar(1, 1842);
  const mesa = azar(1, 6400);
  const acta = `E14-${String(pue).padStart(3, '0')}-${String(mesa).padStart(4, '0')}-03`;
  versiones.set(acta, 1);
  return { acta, mun: azar(1, 20), pue, version: 1, tipo: 'nueva' };
}

async function emitir() {
  const evento = siguienteEvento();
  const id = await redis.xadd(streamActas, 'MAXLEN', '~', MAXLEN, '*', ...camposStream(evento));
  const completo = EventoActaNueva.parse({ ...evento, stream_id: id });
  await redis.publish(CANALES.ACTA_NUEVA, JSON.stringify(completo));
  emitidos++;
  console.log(
    `[emisor-falso] #${emitidos} ${completo.tipo} ${completo.acta} v${completo.version} → ${id}`,
  );
}

console.log(`[emisor-falso] Redis ${url}, cada ${intervalo} ms. Ctrl+C para salir.`);
const temporizador = setInterval(() => emitir().catch((e) => console.error(e.message)), intervalo);

process.on('SIGINT', async () => {
  clearInterval(temporizador);
  await redis.quit();
  console.log(`\n[emisor-falso] ${emitidos} eventos emitidos.`);
  process.exit(0);
});

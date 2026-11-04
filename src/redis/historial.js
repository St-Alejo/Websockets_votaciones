// Lectura de stream:actas para la reanudación (RF-6). Persona 1 escribe el stream;
// mientras su historial no esté, este módulo lo lee directo si Redis responde
// y, si no, usa una memoria local para que Persona 2 pueda probar sin esa pieza.
import { streamActas } from '../contratos/keys.js';
import { eventoDesdeEntrada } from '../contratos/stream.js';
import { obtenerRedis } from './cliente.js';

const MAX_MEMORIA = 10_000;
const memoria = [];

/** Compara ids "ms-seq". Negativo si a es anterior a b. */
export function compararStreamId(a, b) {
  const pa = partir(a);
  const pb = partir(b);
  if (pa.ms !== pb.ms) return pa.ms - pb.ms;
  return pa.seq - pb.seq;
}

function partir(id) {
  const [ms, seq] = String(id ?? '0-0').split('-');
  const nms = Number(ms);
  const nseq = Number(seq ?? 0);
  return {
    ms: Number.isFinite(nms) ? nms : 0,
    seq: Number.isFinite(nseq) ? nseq : 0,
  };
}

/** Stub en memoria. El id tiene que ser un stream id ("ms-seq"). */
export function registrarEnMemoria(evento) {
  memoria.push({ ...evento });
  if (memoria.length > MAX_MEMORIA) memoria.splice(0, memoria.length - MAX_MEMORIA);
}

export function vaciarMemoria() {
  memoria.length = 0;
}

function desdeLista(eventos, streamId, limite) {
  if (eventos.length === 0) {
    return {
      eventos: [],
      stream_id: streamId || '0-0',
      recortado: Boolean(streamId),
      hayMas: false,
    };
  }
  if (streamId && compararStreamId(streamId, eventos[0].stream_id) < 0) {
    return {
      eventos: [],
      stream_id: eventos[eventos.length - 1].stream_id,
      recortado: true,
      hayMas: false,
    };
  }
  const posteriores = streamId
    ? eventos.filter((e) => compararStreamId(e.stream_id, streamId) > 0)
    : eventos.slice();
  const recorte = posteriores.slice(0, limite);
  const stream_id = recorte.length
    ? recorte[recorte.length - 1].stream_id
    : streamId || eventos[eventos.length - 1].stream_id;
  return {
    eventos: recorte,
    stream_id,
    recortado: false,
    hayMas: posteriores.length > limite,
  };
}

function leerDesdeMemoria(streamId, limite) {
  const ordenados = memoria.slice().sort((a, b) => compararStreamId(a.stream_id, b.stream_id));
  return desdeLista(ordenados, streamId, limite);
}

async function leerDesdeRedis(redis, streamId, limite) {
  const primero = await redis.xrange(streamActas, '-', '+', 'COUNT', 1);
  if (!primero?.length) {
    return {
      eventos: [],
      stream_id: streamId || '0-0',
      recortado: Boolean(streamId),
      hayMas: false,
    };
  }
  const idMin = primero[0][0];
  if (streamId && compararStreamId(streamId, idMin) < 0) {
    const ult = await redis.xrevrange(streamActas, '+', '-', 'COUNT', 1);
    return {
      eventos: [],
      stream_id: ult?.[0]?.[0] ?? idMin,
      recortado: true,
      hayMas: false,
    };
  }
  const inicio = streamId ? `(${streamId}` : '-';
  const entradas = await redis.xrange(streamActas, inicio, '+', 'COUNT', limite);
  const eventos = entradas.map((entrada) => eventoDesdeEntrada(entrada));
  const stream_id = eventos.length ? eventos[eventos.length - 1].stream_id : streamId || idMin;
  let hayMas = false;
  if (eventos.length === limite && eventos.length > 0) {
    const siguiente = await redis.xrange(
      streamActas,
      `(${eventos[eventos.length - 1].stream_id}`,
      '+',
      'COUNT',
      1,
    );
    hayMas = siguiente.length > 0;
  }
  return { eventos, stream_id, recortado: false, hayMas };
}

/**
 * Eventos estrictamente posteriores a streamId.
 * `recortado: true` → el cursor ya no está en el stream; hay que pedir snapshot.
 * `hayMas: true` → el hueco supera `max`; también conviene el snapshot.
 */
export async function leerDesde(streamId, max) {
  const limite = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : 500;
  const redis = obtenerRedis();
  if (redis && redis.status === 'ready' && typeof redis.xrange === 'function') {
    return leerDesdeRedis(redis, streamId, limite);
  }
  return leerDesdeMemoria(streamId, limite);
}

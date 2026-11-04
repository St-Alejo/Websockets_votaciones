// Dueño: Persona 1. Historial de actas aplicadas sobre stream:actas (RF-6).
// Pub/Sub no tiene memoria; el Stream sí: ids monótonos (ms-secuencia) que el cliente lleva
// como cursor (Last-Event-ID). XRANGE desde el cursor es O(log N + M) con M = eventos leídos.
import { streamActas } from '../contratos/keys.js';
import { eventoDesdeEntrada } from '../contratos/stream.js';
import { traducirErrorRedis } from '../dominio/errores.js';
import { obtenerRedis } from './cliente.js';

const ID = /^\d+-\d+$/;

/** Compara ids de stream "ms-seq": <0, 0, >0. */
export function compararIds(a, b) {
  const [am, as] = a.split('-').map(BigInt);
  const [bm, bs] = b.split('-').map(BigInt);
  if (am !== bm) return am < bm ? -1 : 1;
  return as === bs ? 0 : as < bs ? -1 : 1;
}

/** Último id del stream, o "0-0" si está vacío. */
export async function ultimoId(redis) {
  try {
    const [ultima] = await redis.xrevrange(streamActas, '+', '-', 'COUNT', 1);
    return ultima ? ultima[0] : '0-0';
  } catch (err) {
    throw traducirErrorRedis(err);
  }
}

function campo(info, nombre) {
  const i = info.indexOf(nombre);
  return i === -1 ? null : info[i + 1];
}

/**
 * Eventos estrictamente posteriores a `cursor`, hasta `max`.
 * - recortado: true → parte de lo ocurrido después del cursor ya se recortó (MAXLEN): el
 *   cliente debe pedir un snapshot en vez de aplicar deltas.
 * - hay_mas: true → quedan eventos: volver a llamar con el stream_id devuelto.
 *
 * Firmas: leerDesde(redis, cursor, max) (Persona 1) o leerDesde(cursor, max) (Persona 2, usa el
 * cliente registrado o el stub en memoria). La respuesta trae hay_mas y su alias hayMas.
 */
export async function leerDesde(...args) {
  const conCliente = args[0] && typeof args[0] === 'object' && typeof args[0].xrange === 'function';
  if (conCliente) return leerDesdeStream(...args);
  const [cursor, max] = args;
  const limite = Number(max) > 0 ? Number(max) : 500;
  const redis = obtenerRedis();
  if (redis?.status === 'ready') {
    const r = await leerDesdeStream(redis, cursor ?? '0-0', limite);
    return conAlias({ recortado: false, ...r });
  }
  return leerDesdeMemoria(cursor, limite);
}

function conAlias(r) {
  return { ...r, hayMas: Boolean(r.hay_mas) };
}

async function leerDesdeStream(redis, cursor, max) {
  const limite = Math.max(1, Math.min(Number(max) || 500, 5000));
  if (!ID.test(String(cursor ?? ''))) {
    return { eventos: [], stream_id: await ultimoId(redis), recortado: true };
  }
  try {
    const [entradas, info] = await Promise.all([
      redis.xrange(streamActas, `(${cursor}`, '+', 'COUNT', limite + 1),
      redis.xinfo('STREAM', streamActas).catch(() => null), // stream inexistente → null
    ]);
    if (!info) return { eventos: [], stream_id: '0-0' };

    // ¿Se perdió algo posterior al cursor? (a) XTRIM/MAXLEN borra por el principio: si hubo
    // recorte (entries-added > length) y el cursor es anterior a la primera entrada viva,
    // pudo perderse algo (conservador: en el borde exacto pide un snapshot de más, nunca
    // pierde eventos). (b) XDEL deja rastro en max-deleted-entry-id.
    const primera = campo(info, 'first-entry')?.[0];
    const huboRecorte = Number(campo(info, 'entries-added')) > Number(campo(info, 'length'));
    const borrado = campo(info, 'max-deleted-entry-id') ?? '0-0';
    const recortado =
      (huboRecorte && primera !== undefined && compararIds(cursor, primera) < 0) ||
      (borrado !== '0-0' && compararIds(cursor, borrado) < 0);
    const hayMas = entradas.length > limite;
    const eventos = entradas.slice(0, limite).map(eventoDesdeEntrada);
    const stream_id = eventos.length
      ? eventos[eventos.length - 1].stream_id
      : campo(info, 'last-generated-id');
    return {
      eventos,
      stream_id,
      ...(recortado && { recortado }),
      ...(hayMas && { hay_mas: true }),
    };
  } catch (err) {
    throw traducirErrorRedis(err);
  }
}

// ─────────────── compatibilidad con Persona 2 (src/transport/reconexion.js) ───────────────
// Persona 2 llama leerDesde(cursor, max) sin cliente y lee `hayMas`. Si el primer argumento no
// es un cliente Redis, se usa el cliente registrado y, si no está listo, un stub en memoria.
const MAX_MEMORIA = 10_000;
const memoria = [];

/** Alias usado por Persona 2. */
export const compararStreamId = (a, b) => compararIds(String(a ?? '0-0'), String(b ?? '0-0'));

/** Stub en memoria (solo pruebas sin Redis). */
export function registrarEnMemoria(evento) {
  memoria.push({ ...evento });
  if (memoria.length > MAX_MEMORIA) memoria.splice(0, memoria.length - MAX_MEMORIA);
}

export function vaciarMemoria() {
  memoria.length = 0;
}

function leerDesdeMemoria(streamId, limite) {
  const eventos = memoria.slice().sort((a, b) => compararStreamId(a.stream_id, b.stream_id));
  if (eventos.length === 0) {
    return {
      eventos: [],
      stream_id: streamId || '0-0',
      recortado: Boolean(streamId),
      hayMas: false,
    };
  }
  if (streamId && compararStreamId(streamId, eventos[0].stream_id) < 0) {
    return { eventos: [], stream_id: eventos.at(-1).stream_id, recortado: true, hayMas: false };
  }
  const posteriores = streamId
    ? eventos.filter((e) => compararStreamId(e.stream_id, streamId) > 0)
    : eventos;
  const pagina = posteriores.slice(0, limite);
  return {
    eventos: pagina,
    stream_id: pagina.length ? pagina.at(-1).stream_id : streamId || eventos.at(-1).stream_id,
    recortado: false,
    hayMas: posteriores.length > limite,
  };
}

// Dueño: Persona 1. Historial de actas aplicadas sobre stream:actas (RF-6).
// Pub/Sub no tiene memoria; el Stream sí: ids monótonos (ms-secuencia) que el cliente lleva
// como cursor (Last-Event-ID). XRANGE desde el cursor es O(log N + M) con M = eventos leídos.
import { streamActas } from '../contratos/keys.js';
import { eventoDesdeEntrada } from '../contratos/stream.js';
import { traducirErrorRedis } from '../dominio/errores.js';

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
 */
export async function leerDesde(redis, cursor, max) {
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

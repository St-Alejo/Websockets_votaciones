// Dueño: Persona 1. Errores tipados que pueden lanzar las funciones del dominio.
// Quien llame a registrarActa (POST /actas, /ws/jurado) debe capturarlos:
//   ErrorRedisNoDisponible → HTTP 503 / mensaje "no_registrada, reintente con el mismo idem"
//   ErrorLimiteTasa        → HTTP 429 con Retry-After
import { ReplyError } from 'ioredis';

export class ErrorRedisNoDisponible extends Error {
  constructor(causa) {
    super(`Redis no disponible: ${causa?.message ?? causa}`);
    this.name = 'ErrorRedisNoDisponible';
    this.codigo = 'redis_no_disponible';
    this.cause = causa;
  }
}

export class ErrorLimiteTasa extends Error {
  constructor(jurado, reintentarEnMs) {
    super(`Límite de tasa excedido para ${jurado}`);
    this.name = 'ErrorLimiteTasa';
    this.codigo = 'limite_tasa';
    this.jurado = jurado;
    this.reintentarEnS = Math.max(1, Math.ceil(reintentarEnMs / 1000));
  }
}

// Respuestas de Redis que significan "no puedo atenderte ahora", no "tu petición está mal".
const REPLY_DE_INDISPONIBILIDAD = /^(LOADING|BUSY|OOM|READONLY|MASTERDOWN|CLUSTERDOWN|TRYAGAIN)/;

/**
 * Traduce un error de ioredis. Conexión cerrada, cola offline deshabilitada, timeout de
 * comando o un ReplyError de indisponibilidad → ErrorRedisNoDisponible. Cualquier otro
 * ReplyError (p. ej. un bug en un script Lua) se devuelve tal cual: es un 500, no un 503.
 */
export function traducirErrorRedis(err) {
  if (esErrorDeDominio(err)) return err;
  // Bugs de programación (cliente null, argumento mal formado): 500, nunca un 503 engañoso.
  if (err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError) {
    return err;
  }
  if (err instanceof ReplyError && !REPLY_DE_INDISPONIBILIDAD.test(err.message)) return err;
  return new ErrorRedisNoDisponible(err);
}

/**
 * Reconoce los errores por `codigo` y no con instanceof: así funciona aunque el módulo se haya
 * cargado dos veces (autoload + vitest) y la clase no sea la misma referencia.
 */
export function esErrorDeDominio(err) {
  return err?.codigo === 'redis_no_disponible' || err?.codigo === 'limite_tasa';
}

// Dueño: Persona 1. Límite de tasa por credencial de jurado (contador por ventana fija).
// Escritura y lectura O(1); memoria: una clave pequeña por jurado activo, que expira sola
// al terminar la ventana. Ventana fija (no deslizante): admite hasta 2×max en el borde entre
// dos ventanas, aceptable aquí porque el objetivo es frenar clientes desbocados, no medir.
import { rateLimit } from '../contratos/keys.js';
import { ErrorLimiteTasa, traducirErrorRedis } from '../dominio/errores.js';

/**
 * Cuenta un envío del jurado; lanza ErrorLimiteTasa si supera `max` en la ventana.
 * @returns {Promise<{ contador: number, restanteMs: number }>}
 */
export async function consumir(redis, jurado, { max, ventanaMs, ahora = Date.now() }) {
  const ventana = Math.floor(ahora / ventanaMs);
  let contador, restanteMs;
  try {
    [contador, restanteMs] = await redis.limiteTasaLua(rateLimit(jurado, ventana), ventanaMs);
  } catch (err) {
    throw traducirErrorRedis(err);
  }
  if (contador > max) throw new ErrorLimiteTasa(jurado, restanteMs > 0 ? restanteMs : ventanaMs);
  return { contador, restanteMs };
}

// Dueño: Persona 3. Heartbeat de bloqueos (RF-7).
// Renueva periódicamente el TTL del bloqueo mientras el auditor trabaja, con
// verificación atómica del token (Lua en bloqueo.js). Si el token deja de
// coincidir (expiró y otro auditor lo tomó), se detiene solo y avisa.
//
// Reglas:
// - El intervalo debe ser MENOR que el TTL (por defecto TTL/3) para renovar
//   antes de que expire.
// - Si el auditor pierde conexión, quien llamaba debe detener el heartbeat
//   (p. ej. al cerrar el WS); si no lo hace, el bloqueo expira solo en Redis.
// - Nunca se mantiene un bloqueo indefinidamente sin ser dueño: cada renovación
//   comprueba el token en Redis, no una variable local.

import { renovarBloqueo, TTL_MS_BLOQUEO } from './bloqueo.js';
import { obtenerRedis } from '../redis/cliente.js';

/** Heartbeats activos por `${acta}:${token}` (evita tareas duplicadas). */
const activos = new Map();

function clave(acta, token) {
  return `${acta}:${token}`;
}

/**
 * Inicia la renovación periódica del bloqueo.
 * @param {string} acta
 * @param {string} token token devuelto por intentarBloquear
 * @param {object} [opciones]
 * @param {number} [opciones.ttlMs] TTL a renovar (por defecto 30 s)
 * @param {number} [opciones.intervaloMs] intervalo (por defecto ttlMs/3)
 * @param {object} [opciones.redis] cliente inyectado (tests)
 * @param {function} [opciones.onPerdido] llamado cuando el bloqueo ya no es nuestro
 * @param {function} [opciones.onError] llamado con el error si renovar lanza
 * @returns {{ detener: () => void, acta: string }} controlador
 */
export function iniciarHeartbeat(acta, token, opciones = {}) {
  if (typeof acta !== 'string' || acta === '') throw new Error('acta requerida');
  if (typeof token !== 'string' || token === '') throw new Error('token requerido');
  const {
    ttlMs = TTL_MS_BLOQUEO,
    intervaloMs = Math.floor(Number(ttlMs) / 3),
    redis: redisExplicito,
    onPerdido,
    onError,
  } = opciones;
  const ttl = Number(ttlMs) || TTL_MS_BLOQUEO;
  const intervalo = Number(intervaloMs) || Math.floor(ttl / 3);
  if (intervalo >= ttl) {
    throw new Error(`intervaloMs (${intervalo}) debe ser menor que ttlMs (${ttl})`);
  }

  const k = clave(acta, token);
  const previo = activos.get(k);
  if (previo) return previo;

  let detenido = false;
  let timer = null;

  const detener = () => {
    if (detenido) return;
    detenido = true;
    if (timer) clearInterval(timer);
    if (activos.get(k)?.control === control) activos.delete(k);
  };

  const control = { detener, acta };
  activos.set(k, { control, timer: null });

  timer = setInterval(async () => {
    if (detenido) return;
    try {
      const redis = redisExplicito ?? obtenerRedis();
      const ok = await renovarBloqueo(acta, token, ttl, redis);
      if (!ok) {
        detener();
        if (typeof onPerdido === 'function') {
          try {
            onPerdido({ acta, token });
          } catch {
            /* el callback no debe romper el loop */
          }
        }
      }
    } catch (err) {
      if (typeof onError === 'function') {
        try {
          onError(err);
        } catch {
          /* ignorar */
        }
      }
    }
  }, intervalo);
  // No mantener el proceso vivo solo por el heartbeat (tests/scripts).
  if (typeof timer.unref === 'function') timer.unref();
  activos.get(k).timer = timer;

  return control;
}

/** Detiene el heartbeat de un (acta, token). Devuelve true si existía. */
export function detenerHeartbeat(acta, token) {
  const k = clave(acta, token);
  const entry = activos.get(k);
  if (!entry) return false;
  entry.control.detener();
  return true;
}

/** Solo para tests: cuántos heartbeats siguen activos. */
export function _activos() {
  return activos.size;
}

// Dueño: Persona 3. Cola distribuida de verificación (RF-7).
// Redis Sorted Set `cola:verificacion` compartido por las 8 instancias.
//
// Convención de prioridad (documentada, determinista):
// - Número MAYOR = más urgente (p. ej. 30 > 20 > 10).
// - Score del ZSET = prioridad directamente; se lee con ZREVRANGE (desc).
// - Desempate estable: a igual score, Redis ordena lexicográficamente por miembro
//   (id del acta). En ZREVRANGE el desempate es lexicográfico inverso, pero en
//   cualquier caso es determinista en todas las instancias.
// - El miembro del ZSET es el id del acta (`E14-puesto-mesa-corporacion`).
//
// Diseño: la cola conserva el acta mientras está asignada; la disponibilidad la
// decide el bloqueo (`lock:acta:{id}`). Así, si un auditor pierde conexión, el
// bloqueo expira y el acta vuelve a estar disponible SIN necesidad de reintegrar
// (no se pierde el acta si una instancia cae entre retirar y reintegrar).

import { colaVerificacion } from '../contratos/keys.js';
import { obtenerRedis } from '../redis/cliente.js';

function cliente(redisExplicito) {
  const r = redisExplicito ?? obtenerRedis();
  if (!r) throw new Error('Redis no disponible: cola de verificación requiere Redis');
  return r;
}

function validarActa(acta) {
  if (typeof acta !== 'string' || acta.trim() === '') {
    throw new Error('acta debe ser un string no vacío');
  }
}

function validarPrioridad(prioridad) {
  if (typeof prioridad !== 'number' || !Number.isFinite(prioridad)) {
    throw new Error('prioridad debe ser un número finito');
  }
}

/** Agrega un acta a la cola. No duplica: si ya existe, no la pisa. Devuelve true si la agregó. */
export async function encolarActa(acta, prioridad, redisExplicito) {
  validarActa(acta);
  validarPrioridad(prioridad);
  const redis = cliente(redisExplicito);
  try {
    // NX: solo agrega si no existe (evita duplicados). ZADD devuelve 1 si agregó.
    const agregados = await redis.zadd(colaVerificacion, 'NX', prioridad, acta);
    return Number(agregados) === 1;
  } catch (err) {
    throw new Error(`encolarActa(${acta}) falló: ${err.message}`, { cause: err });
  }
}

/** Actualiza la prioridad de un acta existente. Devuelve false si el acta no está en cola. */
export async function actualizarPrioridad(acta, prioridad, redisExplicito) {
  validarActa(acta);
  validarPrioridad(prioridad);
  const redis = cliente(redisExplicito);
  try {
    const existe = await redis.zscore(colaVerificacion, acta);
    if (existe === null) return false;
    // XX: solo actualiza si ya existe. CH no necesario; basta con ZADD simple.
    await redis.zadd(colaVerificacion, 'XX', prioridad, acta);
    return true;
  } catch (err) {
    throw new Error(`actualizarPrioridad(${acta}) falló: ${err.message}`, { cause: err });
  }
}

/** Acta específica con su prioridad, o null si no está en cola. */
export async function obtenerActa(acta, redisExplicito) {
  validarActa(acta);
  const redis = cliente(redisExplicito);
  try {
    const score = await redis.zscore(colaVerificacion, acta);
    if (score === null) return null;
    return { acta, prioridad: Number(score) };
  } catch (err) {
    throw new Error(`obtenerActa(${acta}) falló: ${err.message}`, { cause: err });
  }
}

/**
 * Actas pendientes ordenadas por prioridad desc (mayor primero).
 * Paginable con limite/offset para no traer miles de actas de golpe.
 */
export async function pendientes(limite = 100, offset = 0, redisExplicito) {
  const redis = cliente(redisExplicito);
  const lim = Math.max(1, Math.min(Number(limite) || 100, 1000));
  const off = Math.max(0, Number(offset) || 0);
  try {
    const crudo = await redis.zrevrange(colaVerificacion, off, off + lim - 1, 'WITHSCORES');
    const lista = [];
    for (let i = 0; i < crudo.length; i += 2) {
      lista.push({ acta: crudo[i], prioridad: Number(crudo[i + 1]) });
    }
    return lista;
  } catch (err) {
    throw new Error(`pendientes() falló: ${err.message}`, { cause: err });
  }
}

/** Número de actas en la cola. */
export async function tamanioCola(redisExplicito) {
  const redis = cliente(redisExplicito);
  try {
    return Number(await redis.zcard(colaVerificacion));
  } catch (err) {
    throw new Error(`tamanioCola() falló: ${err.message}`, { cause: err });
  }
}

/**
 * Retira un acta de la cola (p. ej. al resolverse definitivamente).
 * En el flujo normal de asignación NO se retira: el bloqueo decide la
 * disponibilidad y el acta permanece para que verCola() la muestre como asignada.
 * Devuelve true si la retiró.
 */
export async function retirarActa(acta, redisExplicito) {
  validarActa(acta);
  const redis = cliente(redisExplicito);
  try {
    return Number(await redis.zrem(colaVerificacion, acta)) === 1;
  } catch (err) {
    throw new Error(`retirarActa(${acta}) falló: ${err.message}`, { cause: err });
  }
}

/**
 * Reintegra un acta que había sido retirada explícitamente.
 * No duplica: si ya está en cola, actualiza su prioridad solo si se indica.
 * Devuelve true si quedó en cola.
 */
export async function reintegrarActa(acta, prioridad, redisExplicito) {
  validarActa(acta);
  validarPrioridad(prioridad);
  const redis = cliente(redisExplicito);
  try {
    await redis.zadd(colaVerificacion, prioridad, acta);
    return true;
  } catch (err) {
    throw new Error(`reintegrarActa(${acta}) falló: ${err.message}`, { cause: err });
  }
}

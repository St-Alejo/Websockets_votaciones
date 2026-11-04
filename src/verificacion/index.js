// Dueño: Persona 3. FACHADA pública de la cola de verificación (RF-7).
// Implementación real en Redis (compartida por las 8 instancias):
// - Cola: `cola:verificacion` ZSET (score = prioridad, mayor = más urgente).
// - Bloqueo: `lock:acta:{id}` SET NX PX con token, liberación/renovación Lua.
// - La cola conserva el acta mientras está asignada; el bloqueo decide la
//   disponibilidad. Ver `cola.js` para la justificación.
// Firmas intactas según src/contratos/interfaces.js (no usar valores por defecto).

import { CANALES } from '../contratos/canales.js';
import { obtenerRedis } from '../redis/cliente.js';
import {
  actualizarPrioridad,
  encolarActa,
  obtenerActa,
  pendientes,
  reintegrarActa,
  retirarActa,
  tamanioCola,
} from './cola.js';
import {
  consultarPropietario,
  intentarBloquear,
  liberarBloqueo,
  TTL_MS_BLOQUEO,
} from './bloqueo.js';

/** Publica un EventoVerificacion best-effort (nunca rompe el flujo principal). */
async function publicar(evento) {
  try {
    const redis = obtenerRedis();
    if (!redis || typeof redis.publish !== 'function') return;
    if (redis.status && redis.status !== 'ready') return;
    await redis.publish(CANALES.VERIFICACION, JSON.stringify(evento));
  } catch {
    /* Pub/Sub es aviso, no fuente de verdad */
  }
}

/** @type {import('../contratos/interfaces.js').tomarCaso} */
export async function tomarCaso(auditor) {
  if (typeof auditor !== 'string' || auditor === '') {
    throw new Error('auditor debe ser un string no vacío');
  }
  // Recorre por prioridad y toma la primera libre (bloqueo atómico NX).
  // Límite 50 por intento: evita barrer miles si todo está bloqueado.
  const candidatas = await pendientes(50, 0);
  for (const c of candidatas) {
    const r = await intentarBloquear(c.acta, auditor, TTL_MS_BLOQUEO);
    if (r) {
      await publicar({ tipo: 'asignada', acta: c.acta, auditor });
      return { acta: c.acta, token: r.token, ttl_ms: r.ttl_ms };
    }
  }
  return null;
}

/** @type {import('../contratos/interfaces.js').liberarCaso} */
export async function liberarCaso(auditor, acta, token) {
  if (typeof auditor !== 'string' || auditor === '') {
    throw new Error('auditor debe ser un string no vacío');
  }
  const ok = await liberarBloqueo(acta, token);
  if (ok) await publicar({ tipo: 'liberada', acta, auditor });
  return ok;
}

/** Vista de la cola para las consolas (solo lectura). */
export async function verCola() {
  const lista = await pendientes(200, 0);
  const filas = await Promise.all(
    lista.map(async (c) => {
      try {
        const prop = await consultarPropietario(c.acta);
        return { ...c, asignada_a: prop?.auditor ?? (prop ? 'desconocido' : null) };
      } catch {
        return { ...c, asignada_a: null };
      }
    }),
  );
  return filas;
}

// ── Utilidades adicionales (no son parte del contrato entre personas) ──

/** Encola un acta dudosa (la llama P1/dominio o tests). */
export async function encolarParaVerificacion(acta, prioridad) {
  const agregada = await encolarActa(acta, prioridad);
  if (agregada) await publicar({ tipo: 'encolada', acta });
  return agregada;
}

/**
 * Marca un caso como resuelto: retira de la cola y libera el bloqueo
 * (solo si el token sigue siendo el dueño). Devuelve true si lo resolvió.
 */
export async function resolverCaso(auditor, acta, token) {
  const ok = await liberarBloqueo(acta, token);
  if (!ok) return false;
  await retirarActa(acta);
  await publicar({ tipo: 'resuelta', acta, auditor });
  return true;
}

export {
  actualizarPrioridad,
  obtenerActa,
  reintegrarActa,
  retirarActa,
  tamanioCola,
  TTL_MS_BLOQUEO,
};

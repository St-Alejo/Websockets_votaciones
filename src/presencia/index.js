// Dueño: Persona 3. FACHADA pública de presencia (RF-8).
// Implementación real en Redis (compartida por las 8 instancias):
// presencia:{auditor} con TTL renovado por latido + eventos en el canal "presencia".
// Sin Redis (desarrollo degradado) usa memoria local de ESTA instancia.
// Firmas intactas según src/contratos/interfaces.js.

import { obtenerRedis } from '../redis/cliente.js';
import {
  activos,
  actualizarActa as actualizarActaTracker,
  actualizarEstado as actualizarEstadoTracker,
  detectarFantasmas,
  latido as latidoTracker,
  purgarExpirados,
  salir as salirTracker,
} from './tracker.js';

/** Respaldo local solo para desarrollo sin Redis (no es fuente de verdad). */
const conectados = new Map();

function hayRedis() {
  try {
    const r = obtenerRedis();
    return !!r && (!r.status || r.status === 'ready');
  } catch {
    return false;
  }
}

/** Marca al auditor como conectado (o renueva su latido). */
export async function latido(auditor, { instancia, acta_actual = null }) {
  if (hayRedis()) {
    await latidoTracker(auditor, { instancia, acta_actual });
    return;
  }
  const previo = conectados.get(auditor);
  conectados.set(auditor, {
    auditor,
    estado: 'online',
    instancia,
    acta_actual,
    desde: previo?.desde ?? Date.now(),
  });
}

export async function salir(auditor) {
  if (hayRedis()) {
    await salirTracker(auditor);
    return;
  }
  conectados.delete(auditor);
}

/** @type {import('../contratos/interfaces.js').presentes} */
export async function presentes() {
  if (hayRedis()) return activos();
  return [...conectados.values()];
}

export {
  actualizarActaTracker as actualizarActa,
  actualizarEstadoTracker as actualizarEstado,
  detectarFantasmas,
  purgarExpirados,
};

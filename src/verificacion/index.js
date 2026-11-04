// Dueño: Persona 3. FACHADA pública de la cola de verificación (RF-7).
// STUB: memoria local de ESTA instancia, así que dos auditores en instancias distintas SÍ
// podrían tomar la misma acta. El real va en Redis: cola:verificacion (ZSET por prioridad),
// lock:acta:{id} con SET NX PX + token, renovación mientras el auditor trabaja y liberación
// con un script Lua que compara el token antes de borrar.
import { randomUUID } from 'node:crypto';
import { avisoStub } from '../contratos/stub.js';

const DUENO = 'Persona 3';
const TTL_MS = 30_000;

// Actas dudosas falsas, ordenadas por prioridad (mayor primero).
const cola = [
  { acta: 'E14-176-0042-03', prioridad: 30 },
  { acta: 'E14-201-0007-03', prioridad: 20 },
  { acta: 'E14-033-0115-03', prioridad: 10 },
];

/** acta → { auditor, token } */
const bloqueos = new Map();

/** @type {import('../contratos/interfaces.js').tomarCaso} */
export async function tomarCaso(auditor) {
  // STUB
  avisoStub('tomarCaso', DUENO);
  const libre = cola.find((c) => !bloqueos.has(c.acta));
  if (!libre) return null;
  const token = randomUUID();
  bloqueos.set(libre.acta, { auditor, token });
  return { acta: libre.acta, token, ttl_ms: TTL_MS };
}

/** @type {import('../contratos/interfaces.js').liberarCaso} */
export async function liberarCaso(auditor, acta, token) {
  // STUB
  avisoStub('liberarCaso', DUENO);
  const b = bloqueos.get(acta);
  if (!b || b.token !== token || b.auditor !== auditor) return false;
  bloqueos.delete(acta);
  return true;
}

/** Vista de la cola para las consolas (solo lectura). */
export async function verCola() {
  return cola.map((c) => ({ ...c, asignada_a: bloqueos.get(c.acta)?.auditor ?? null }));
}

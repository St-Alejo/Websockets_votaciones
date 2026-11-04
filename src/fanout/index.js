// Dueño: Persona 2. FACHADA pública del fan-out: las demás personas importan solo de aquí.
// STUB: índice tópico → conexiones en memoria de ESTA instancia. Es la estructura correcta
// para RF-5 (alta/baja O(1), recorrido O(suscriptores del tópico)), pero falta lo difícil:
// suscribirse al backplane de Redis, agregar por ventana, enviar por lotes cediendo el
// Event Loop (RF-4) y vigilar la contrapresión (RF-9).
import { avisoStub } from '../contratos/stub.js';

const DUENO = 'Persona 2';

/** @type {Map<string, Set<object>>} */
const porTopico = new Map();

/** @type {import('../contratos/interfaces.js').suscribir} */
export function suscribir(conexion, topico) {
  // STUB
  avisoStub('suscribir', DUENO);
  let conjunto = porTopico.get(topico);
  if (!conjunto) {
    conjunto = new Set();
    porTopico.set(topico, conjunto);
  }
  conjunto.add(conexion);
}

/** @type {import('../contratos/interfaces.js').desuscribir} */
export function desuscribir(conexion, topico) {
  // STUB
  avisoStub('desuscribir', DUENO);
  const conjunto = porTopico.get(topico);
  if (!conjunto) return;
  conjunto.delete(conexion);
  if (conjunto.size === 0) porTopico.delete(topico);
}

/** Conexiones de un tópico (solo lectura). */
export function suscriptores(topico) {
  return porTopico.get(topico) ?? new Set();
}

/** Para métricas: total de suscripciones y tópicos activos en esta instancia. */
export function estadisticas() {
  let suscripciones = 0;
  for (const c of porTopico.values()) suscripciones += c.size;
  return { topicos: porTopico.size, suscripciones };
}

// Dueño: Persona 3. FACHADA pública de presencia (RF-8).
// STUB: memoria local de ESTA instancia (no ve auditores de las otras 7). El real va en
// Redis: presencia:{auditor} con TTL renovado por latido, y eventos en el canal "presencia".
import { avisoStub } from '../contratos/stub.js';

const DUENO = 'Persona 3';

/** auditor → EventoPresencia */
const conectados = new Map();

/** Marca al auditor como conectado (o renueva su latido). */
export async function latido(auditor, { instancia, acta_actual = null }) {
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
  conectados.delete(auditor);
}

/** @type {import('../contratos/interfaces.js').presentes} */
export async function presentes() {
  // STUB
  avisoStub('presentes', DUENO);
  return [...conectados.values()];
}

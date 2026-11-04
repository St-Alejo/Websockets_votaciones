// Dueño: Persona 1. Validación del acta entrante. El esquema y la regla contable son
// contrato compartido (src/contratos/esquemas.js); aquí solo se adaptan al dominio.
import { ActaEntrante, cumpleReglaContable } from '../contratos/esquemas.js';

export { ActaEntrante, cumpleReglaContable };

/** @returns {{ ok: true, acta: object } | { ok: false, motivo: string }} */
export function validarActa(entrada) {
  const r = ActaEntrante.safeParse(entrada);
  if (r.success) return { ok: true, acta: r.data };
  return {
    ok: false,
    motivo: r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; '),
  };
}

/** Descuadre de la regla contable: 0 si cuadra. Se usa como prioridad en la cola. */
export function descuadre(acta) {
  const suma = Object.values(acta.votos).reduce((a, b) => a + b, 0);
  return Math.abs(suma - acta.sufragantes);
}

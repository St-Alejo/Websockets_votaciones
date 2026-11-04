// CONTRATO COMPARTIDO — solo se cambia por PR aprobado por las 3 personas.
// Formato de cada entrada de stream:actas. El id lo asigna XADD, por eso no se guarda dentro.
//   XADD stream:actas MAXLEN ~ N * evento '{"acta":"...","mun":11,"pue":176,"version":1,"tipo":"nueva"}'
import { EventoActaNueva } from './esquemas.js';

export const CAMPO_EVENTO = 'evento';

/** Campos para XADD a partir de un evento (sin stream_id). */
export function camposStream(evento) {
  const { stream_id: _ignorado, ...resto } = evento;
  return [CAMPO_EVENTO, JSON.stringify(resto)];
}

/** Entrada de ioredis XRANGE/XREAD ([id, [campo, valor, ...]]) → EventoActaNueva validado. */
export function eventoDesdeEntrada([id, campos]) {
  const i = campos.indexOf(CAMPO_EVENTO);
  if (i === -1) throw new Error(`Entrada ${id} sin campo "${CAMPO_EVENTO}"`);
  return EventoActaNueva.parse({ ...JSON.parse(campos[i + 1]), stream_id: id });
}

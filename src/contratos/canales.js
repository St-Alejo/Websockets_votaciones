// CONTRATO COMPARTIDO — solo se cambia por PR aprobado por las 3 personas.
// Canales Pub/Sub de Redis y formato de los tópicos públicos.

export const CANALES = Object.freeze({
  /** EventoActaNueva: un acta se aplicó (nueva o corrección). Lo publica Persona 1. */
  ACTA_NUEVA: 'acta:nueva',
  /** EventoVerificacion: cambios en la cola de verificación. Lo publica Persona 3. */
  VERIFICACION: 'verificacion',
  /** EventoPresencia: auditores que entran o salen. Lo publica Persona 3. */
  PRESENCIA: 'presencia',
});

/**
 * Tópico público al que se suscribe un cliente: "dep" | "mun:11" | "pue:176" | "mesa:4201".
 * Es el mismo texto que usan GET /sse/publico?topico=... y snapshot(niveles[]).
 */
export function topico(nivel, id) {
  return nivel === 'dep' ? 'dep' : `${nivel}:${id}`;
}

/** "mun:11" → { nivel: 'mun', id: '11' }; "dep" → { nivel: 'dep', id: null }. */
export function parsearTopico(texto) {
  if (texto === 'dep') return { nivel: 'dep', id: null };
  const m = /^(mun|pue|mesa):([A-Za-z0-9-]+)$/.exec(String(texto ?? ''));
  if (!m) throw new Error(`Tópico inválido "${texto}"`);
  return { nivel: m[1], id: m[2] };
}

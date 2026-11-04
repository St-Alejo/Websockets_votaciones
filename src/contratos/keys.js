// CONTRATO COMPARTIDO — solo se cambia por PR aprobado por las 3 personas.
// Única fuente de verdad de los nombres de claves en Redis. Nadie escribe una clave
// "a mano" ('acta:' + id): siempre se usa el builder correspondiente.

/** Niveles de agregación, de mayor a menor. */
export const NIVELES = Object.freeze(['dep', 'mun', 'pue', 'mesa']);

function validarNivel(nivel, id) {
  if (!NIVELES.includes(nivel)) {
    throw new Error(`Nivel inválido "${nivel}". Use uno de: ${NIVELES.join(', ')}`);
  }
  if (nivel !== 'dep' && (id === undefined || id === null || id === '')) {
    throw new Error(`El nivel "${nivel}" requiere un id`);
  }
}

/** Sufijo de nivel: "dep" | "mun:11" | "pue:176" | "mesa:4201". */
function sufijo(nivel, id) {
  validarNivel(nivel, id);
  return nivel === 'dep' ? 'dep' : `${nivel}:${id}`;
}

/** HASH del acta: version_aplicada, votos (JSON), sufragantes, estado (aplicada|dudosa), jurado, recibo, ts. */
export const acta = (id) => `acta:${id}`;

/** Versiones recibidas de un acta (estructura a elección de Persona 1, p. ej. HASH version → JSON). */
export const actaVersiones = (id) => `acta:${id}:versiones`;

/** Respuesta original de un envío, para responder igual a los reenvíos. TTL 24 h. */
export const idem = (k) => `idem:${k}`;

/** TTL de las claves de idempotencia, en segundos. */
export const TTL_IDEM_S = 24 * 60 * 60;

/** Acumulado de un nivel: "acum:dep" | "acum:mun:{id}" | "acum:pue:{id}" | "acum:mesa:{id}". */
export const acum = (nivel, id) => `acum:${sufijo(nivel, id)}`;

/** ZSET candidato → votos del nivel. */
export const rank = (nivel, id) => `rank:${sufijo(nivel, id)}`;

/** Catálogo de mesas del nivel (total de mesas, para el % informado): "cat:mun:11:mesas". */
export const catalogo = (nivel, id) => `cat:${sufijo(nivel, id)}:mesas`;

/** STREAM con el historial de actas aplicadas (RF-6). */
export const streamActas = 'stream:actas';

/** ZSET de actas dudosas, score = prioridad. */
export const colaVerificacion = 'cola:verificacion';

/** Bloqueo de un acta en verificación; valor = token del dueño. */
export const lockActa = (id) => `lock:acta:${id}`;

/** Presencia de un auditor; TTL renovado por latido. */
export const presencia = (auditor) => `presencia:${auditor}`;

/** Contador de límite de tasa por jurado y ventana. */
export const rateLimit = (jurado, ventana) => `rl:${jurado}:${ventana}`;

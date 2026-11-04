// CONTRATO COMPARTIDO — solo se cambia por PR aprobado por las 3 personas.
// Firmas de las funciones que cada persona expone a las demás. Cada una vive en la
// "fachada" (index.js) de la carpeta de su dueño; las demás personas importan SOLO de ahí.
// test/humo/contratos.test.js comprueba que existan con el número de parámetros indicado.

/**
 * @typedef {import('zod').infer<typeof import('./esquemas.js').ActaEntrante>} ActaEntrante
 * @typedef {import('zod').infer<typeof import('./esquemas.js').RespuestaRegistro>} RespuestaRegistro
 * @typedef {import('zod').infer<typeof import('./esquemas.js').Acumulado>} Acumulado
 * @typedef {import('zod').infer<typeof import('./esquemas.js').FilaRanking>} FilaRanking
 * @typedef {import('zod').infer<typeof import('./esquemas.js').Snapshot>} Snapshot
 * @typedef {import('zod').infer<typeof import('./esquemas.js').EventoActaNueva>} EventoActaNueva
 * @typedef {import('zod').infer<typeof import('./esquemas.js').EventoPresencia>} EventoPresencia
 * @typedef {'dep'|'mun'|'pue'|'mesa'} Nivel
 * @typedef {string} Topico  "dep" | "mun:11" | "pue:176" | "mesa:4201"
 */

// ───────────────────────── Persona 1 — src/dominio/index.js ─────────────────────────

/**
 * Registra un acta de forma idempotente y atómica (RF-1, RF-2, RF-3).
 * Nunca lanza por datos inválidos: responde estado "rechazada".
 * @callback registrarActa
 * @param {unknown} acta  JSON crudo; se valida con ActaEntrante
 * @returns {Promise<RespuestaRegistro>}
 */

/**
 * Aplica al acumulado un acta dudosa ya resuelta por un auditor (RF-7).
 * @callback aplicarActaVerificada
 * @param {ActaEntrante} acta
 * @param {number} version
 * @returns {Promise<{ aplicada: boolean, stream_id?: string }>}
 */

/**
 * @callback leerAcumulado
 * @param {Nivel} nivel
 * @param {string|number|null} id  null para "dep"
 * @returns {Promise<Acumulado>}
 */

/**
 * Top N de candidatos de un nivel, sin recorrer todo (ZSET).
 * @callback ranking
 * @param {Nivel} nivel
 * @param {string|number|null} id
 * @param {number} topN
 * @returns {Promise<FilaRanking[]>}
 */

/**
 * Fotografía completa de varios tópicos + stream_id consistente con ella (RF-6).
 * @callback snapshot
 * @param {Topico[]} niveles
 * @returns {Promise<Snapshot>}
 */

/**
 * Eventos del stream posteriores a streamId (exclusivo). Si streamId ya fue recortado
 * del stream, devuelve { eventos: [], stream_id, recortado: true } → el cliente pide snapshot.
 * @callback leerHistorialDesde
 * @param {string} streamId
 * @param {number} max
 * @returns {Promise<{ eventos: EventoActaNueva[], stream_id: string, recortado?: boolean }>}
 */

// ───────────────────────── Persona 2 — src/fanout/index.js ─────────────────────────

/**
 * Alta de una conexión en un tópico. Síncrona: está en el camino caliente.
 * `conexion` es un objeto opaco del transporte (SSE o WS) definido por Persona 2.
 * @callback suscribir
 * @param {object} conexion
 * @param {Topico} topico
 * @returns {void}
 */

/**
 * @callback desuscribir
 * @param {object} conexion
 * @param {Topico} topico
 * @returns {void}
 */

// ───────────────────────── Persona 3 — src/verificacion, src/presencia ─────────────────────────

/**
 * Asigna al auditor el acta dudosa de mayor prioridad con un bloqueo exclusivo (RF-7).
 * @callback tomarCaso
 * @param {string} auditor
 * @returns {Promise<{ acta: string, token: string, ttl_ms: number } | null>}  null si la cola está vacía
 */

/**
 * Devuelve el caso a la cola solo si `token` sigue siendo el dueño del bloqueo (RF-7).
 * @callback liberarCaso
 * @param {string} auditor
 * @param {string} acta
 * @param {string} token
 * @returns {Promise<boolean>}  false si el bloqueo ya no le pertenece
 */

/**
 * Auditores conectados en cualquier instancia (RF-8).
 * @callback presentes
 * @returns {Promise<EventoPresencia[]>}
 */

/** Módulo → función → número de parámetros (Function.length). No usar valores por defecto en estas firmas. */
export const FIRMAS = Object.freeze({
  'src/dominio/index.js': {
    registrarActa: 1,
    aplicarActaVerificada: 2,
    leerAcumulado: 2,
    ranking: 3,
    snapshot: 1,
    leerHistorialDesde: 2,
  },
  'src/fanout/index.js': { suscribir: 2, desuscribir: 2 },
  'src/verificacion/index.js': { tomarCaso: 1, liberarCaso: 3 },
  'src/presencia/index.js': { presentes: 0 },
});

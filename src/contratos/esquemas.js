// CONTRATO COMPARTIDO — solo se cambia por PR aprobado por las 3 personas.
// Esquemas zod de todos los mensajes que cruzan fronteras entre personas.
import { z } from 'zod';

const entero = z.number().int().nonnegative();

/** Votos: C1..Cn + BLANCO + NULO + NO_MARCADO, todos enteros ≥ 0. */
export const Votos = z
  .record(z.string().regex(/^(C\d+|BLANCO|NULO|NO_MARCADO)$/, 'Clave de voto inválida'), entero)
  .refine((v) => 'BLANCO' in v && 'NULO' in v && 'NO_MARCADO' in v, {
    message: 'Faltan BLANCO, NULO o NO_MARCADO',
  })
  .refine((v) => Object.keys(v).some((k) => /^C\d+$/.test(k)), {
    message: 'Debe haber al menos un candidato C1..Cn',
  });

/** Mensaje de transmisión de acta (sección 3.1 del enunciado). */
export const ActaEntrante = z.object({
  acta: z.string().regex(/^E14-\d+-\d+-\d+$/, 'Formato esperado E14-puesto-mesa-corporacion'),
  mesa: z.number().int().positive(),
  puesto: z.number().int().positive(),
  municipio: z.number().int().positive(),
  version: z.number().int().positive(),
  jurado: z.string().min(1),
  ts_cierre: z.number().int().positive(),
  votos: Votos,
  sufragantes: entero,
  hash_foto: z.string().min(1),
  idem: z.string().min(8).max(128),
});

/**
 * Regla contable: suma de votos (candidatos + BLANCO) + NULO + NO_MARCADO = sufragantes.
 * Un acta que NO cuadra no se rechaza: es válida estructuralmente pero queda "dudosa"
 * y pasa a verificación humana.
 */
export function cumpleReglaContable(acta) {
  const suma = Object.values(acta.votos).reduce((a, b) => a + b, 0);
  return suma === acta.sufragantes;
}

export const ESTADOS_REGISTRO = Object.freeze([
  'registrada',
  'duplicada',
  'version_obsoleta',
  'conflicto',
  'dudosa',
  'rechazada',
]);

/** Respuesta inequívoca al jurado (RF-1). También es lo que se guarda en idem:{k}. */
export const RespuestaRegistro = z.object({
  estado: z.enum(ESTADOS_REGISTRO),
  acta: z.string(),
  version: z.number().int(),
  recibo: z.string().nullable(),
  version_vigente: z.number().int().optional(),
  motivo: z.string().optional(),
});

/** Publicado en el canal acta:nueva y guardado en stream:actas (RF-4, RF-6). */
export const EventoActaNueva = z.object({
  stream_id: z.string().regex(/^\d+-\d+$/),
  acta: z.string(),
  mun: z.number().int(),
  pue: z.number().int(),
  version: z.number().int().positive(),
  tipo: z.enum(['nueva', 'correccion']),
});

/** Publicado en el canal verificacion (RF-7). */
export const EventoVerificacion = z.object({
  tipo: z.enum(['encolada', 'asignada', 'liberada', 'resuelta']),
  acta: z.string(),
  auditor: z.string().optional(),
});

/** Publicado en el canal presencia (RF-8). */
export const EventoPresencia = z.object({
  auditor: z.string(),
  estado: z.enum(['online', 'offline']),
  instancia: z.string(),
  acta_actual: z.string().nullable().optional(),
  desde: z.number().int().optional(),
});

/** Acumulado de un nivel (lo que devuelve leerAcumulado). */
export const Acumulado = z.object({
  nivel: z.enum(['dep', 'mun', 'pue', 'mesa']),
  id: z.string().nullable(),
  votos: z.record(z.string(), entero),
  sufragantes: entero,
  mesas_informadas: entero,
  mesas_totales: entero,
  porcentaje_informado: z.number().min(0).max(100),
});

/** Fila de ranking: candidato y sus votos, orden descendente. */
export const FilaRanking = z.object({ candidato: z.string(), votos: entero });

/** Fotografía completa de varios niveles + el stream_id desde el que continuar (RF-6). */
export const Snapshot = z.object({
  niveles: z.record(z.string(), Acumulado),
  stream_id: z.string().regex(/^\d+-\d+$/),
});

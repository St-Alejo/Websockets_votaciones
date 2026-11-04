// Dueño: Persona 1. FACHADA pública del dominio: las demás personas importan solo de aquí.
// Todas las funciones son STUBS con la firma final (ver src/contratos/interfaces.js).
// Las implementaciones reales van en Redis: scripts Lua atómicos en src/redis/, idempotencia
// con idem:{k} (TTL 24 h), acumulados acum:* + rank:* y stream:actas para el historial.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ActaEntrante, cumpleReglaContable } from '../contratos/esquemas.js';
import { streamActas } from '../contratos/keys.js';
import { parsearTopico, topico as aTopico } from '../contratos/canales.js';
import { avisoStub } from '../contratos/stub.js';
import { obtenerRedis } from '../redis/cliente.js';

let configDominio = null;

/** Lo llama server.js al arrancar: instancia, límite de tasa y retención del stream. */
export function configurarDominio(config) {
  configDominio = config;
}

export const configActual = () => configDominio;

export { ErrorLimiteTasa, ErrorRedisNoDisponible } from './errores.js';

const DATOS = JSON.parse(readFileSync(new URL('./datos-stub.json', import.meta.url), 'utf8'));
const DUENO = 'Persona 1';

// STUB: memoria local por instancia. El real guarda idem:{k} en Redis (compartido por las 8).
const respuestasPorIdem = new Map();

/** @type {import('../contratos/interfaces.js').registrarActa} */
export async function registrarActa(acta) {
  // STUB
  avisoStub('registrarActa', DUENO);
  const r = ActaEntrante.safeParse(acta);
  if (!r.success) {
    return {
      estado: 'rechazada',
      acta: typeof acta?.acta === 'string' ? acta.acta : '',
      version: Number.isInteger(acta?.version) ? acta.version : 0,
      recibo: null,
      motivo: r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; '),
    };
  }
  const datos = r.data;
  const previa = respuestasPorIdem.get(datos.idem);
  if (previa) return { ...previa, estado: 'duplicada' };

  const respuesta = {
    estado: cumpleReglaContable(datos) ? 'registrada' : 'dudosa',
    acta: datos.acta,
    version: datos.version,
    recibo: `STUB-${randomUUID().slice(0, 8)}`,
  };
  respuestasPorIdem.set(datos.idem, respuesta);
  return respuesta;
}

/** @type {import('../contratos/interfaces.js').aplicarActaVerificada} */
export async function aplicarActaVerificada(acta, version) {
  // STUB
  avisoStub('aplicarActaVerificada', DUENO);
  void acta;
  void version;
  return { aplicada: true };
}

function acumuladoStub(nivel, id) {
  const clave = aTopico(nivel, id);
  const base = DATOS.niveles[clave] ?? { votos: {}, mesas_informadas: 0, mesas_totales: 0 };
  const sufragantes = Object.values(base.votos).reduce((a, b) => a + b, 0);
  return {
    nivel,
    id: nivel === 'dep' ? null : String(id),
    votos: { ...base.votos },
    sufragantes,
    mesas_informadas: base.mesas_informadas,
    mesas_totales: base.mesas_totales,
    porcentaje_informado: base.mesas_totales
      ? Math.round((base.mesas_informadas / base.mesas_totales) * 10000) / 100
      : 0,
  };
}

/** @type {import('../contratos/interfaces.js').leerAcumulado} */
export async function leerAcumulado(nivel, id) {
  // STUB
  avisoStub('leerAcumulado', DUENO);
  return acumuladoStub(nivel, id);
}

/** @type {import('../contratos/interfaces.js').ranking} */
export async function ranking(nivel, id, topN) {
  // STUB
  avisoStub('ranking', DUENO);
  const { votos } = acumuladoStub(nivel, id);
  return Object.entries(votos)
    .filter(([k]) => /^C\d+$/.test(k))
    .map(([candidato, v]) => ({ candidato, votos: v }))
    .sort((a, b) => b.votos - a.votos)
    .slice(0, topN ?? 10);
}

/** @type {import('../contratos/interfaces.js').snapshot} */
export async function snapshot(niveles) {
  // STUB
  avisoStub('snapshot', DUENO);
  const resultado = {};
  for (const t of niveles) {
    const { nivel, id } = parsearTopico(t);
    resultado[t] = acumuladoStub(nivel, id);
  }
  return { niveles: resultado, stream_id: await ultimoStreamId() };
}

/** @type {import('../contratos/interfaces.js').leerHistorialDesde} */
export async function leerHistorialDesde(streamId, max) {
  // STUB: no devuelve eventos; el real hace XRANGE stream:actas (streamId + COUNT max.
  avisoStub('leerHistorialDesde', DUENO);
  void streamId;
  void max;
  return { eventos: [], stream_id: await ultimoStreamId() };
}

/** Último id de stream:actas si Redis está disponible (p. ej. con el emisor falso); si no, el del JSON. */
async function ultimoStreamId() {
  const redis = obtenerRedis();
  if (redis?.status === 'ready') {
    try {
      const [ultima] = await redis.xrevrange(streamActas, '+', '-', 'COUNT', 1);
      if (ultima) return ultima[0];
    } catch {
      /* se usa el valor fijo */
    }
  }
  return DATOS.stream_id;
}

// Dueño: Persona 1. Lectura de acumulados, ranking y snapshot consistente.
//   acum:{nivel}  HASH  → leer un nivel es O(campos) = O(candidatos).
//   rank:{nivel}  ZSET  → top N en O(log M + N) sin recorrer todos los candidatos.
//   snapshot.lua        → varios niveles + último stream_id en una sola ejecución atómica.
import * as K from '../contratos/keys.js';
import { parsearTopico } from '../contratos/canales.js';
import { traducirErrorRedis } from '../dominio/errores.js';

const CAMPOS_INTERNOS = new Set(['informadas', 'sufragantes']);

function aObjeto(plano) {
  const o = {};
  for (let i = 0; i < plano.length; i += 2) o[plano[i]] = Number(plano[i + 1]);
  return o;
}

/** HASH acum:* + total del catálogo → Acumulado del contrato. */
export function construirAcumulado(nivel, id, campos, totalCatalogo) {
  const votos = {};
  for (const [k, v] of Object.entries(campos)) if (!CAMPOS_INTERNOS.has(k)) votos[k] = v;
  const informadas = campos.informadas ?? 0;
  const totales = nivel === 'mesa' ? 1 : Number(totalCatalogo ?? 0);
  return {
    nivel,
    id: nivel === 'dep' ? null : String(id),
    votos,
    sufragantes: campos.sufragantes ?? 0,
    mesas_informadas: informadas,
    mesas_totales: totales,
    porcentaje_informado: totales
      ? Math.min(100, Math.round((informadas / totales) * 10_000) / 100)
      : 0,
  };
}

/**
 * Fotografía consistente de varios tópicos ("dep", "mun:11", ...).
 * @returns {Promise<{ niveles: Record<string, object>, stream_id: string }>}
 */
export async function leerSnapshot(redis, topicos) {
  const pedidos = [...new Set(topicos)].map((t) => ({ t, ...parsearTopico(t) }));
  const claves = pedidos.flatMap(({ nivel, id }) => [
    K.acum(nivel, id ?? undefined),
    // Para mesa no hay catálogo (total = 1); se pasa una clave inexistente del mismo espacio.
    nivel === 'mesa' ? K.catalogo('mesa', id) : K.catalogo(nivel, id ?? undefined),
  ]);
  claves.push(K.streamActas);

  let crudo;
  try {
    crudo = await redis.snapshotLua(claves.length, ...claves);
  } catch (err) {
    throw traducirErrorRedis(err);
  }
  const niveles = {};
  pedidos.forEach(({ t, nivel, id }, i) => {
    niveles[t] = construirAcumulado(nivel, id, aObjeto(crudo[2 * i]), crudo[2 * i + 1]);
  });
  return { niveles, stream_id: crudo[crudo.length - 1] };
}

/** Top N de candidatos de un nivel. */
export async function leerRanking(redis, nivel, id, topN) {
  const n = Math.max(1, Math.min(Number(topN) || 10, 100));
  try {
    if (nivel === 'mesa') {
      // No hay rank:mesa:* (una mesa tiene pocos candidatos): se ordena el HASH.
      const campos = await redis.hgetall(K.acum('mesa', id));
      return Object.entries(campos)
        .filter(([c]) => /^C\d+$/.test(c))
        .map(([candidato, v]) => ({ candidato, votos: Number(v) }))
        .sort((a, b) => b.votos - a.votos || a.candidato.localeCompare(b.candidato))
        .slice(0, n);
    }
    const plano = await redis.zrevrange(K.rank(nivel, id ?? undefined), 0, n - 1, 'WITHSCORES');
    const filas = [];
    for (let i = 0; i < plano.length; i += 2)
      filas.push({ candidato: plano[i], votos: Number(plano[i + 1]) });
    return filas;
  } catch (err) {
    throw traducirErrorRedis(err);
  }
}

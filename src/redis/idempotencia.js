// Dueño: Persona 1. Idempotencia (RF-1). La verificación y la escritura ocurren DENTRO de
// scripts/registrar.lua; aquí está lo que se calcula en Node antes de llamarlo.
//
// Dos capas: (1) idem:{k} con TTL 24 h → camino rápido para reintentos del mismo envío;
// (2) acta:{id}:versiones guarda el hash del contenido por versión → si idem expiró o el
// cliente generó un idem nuevo para el mismo contenido, igual se responde "duplicada".
import { createHash } from 'node:crypto';
import { TTL_IDEM_S, idem } from '../contratos/keys.js';

export { TTL_IDEM_S };

/**
 * Hash del contenido que define "la misma acta": geografía, votos y sufragantes. No incluye
 * idem, jurado, ts_cierre ni hash_foto: un reenvío del mismo conteo con otra foto o desde
 * otro dispositivo es la misma acta. Las claves de votos se ordenan (JSON canónico).
 */
export function hashContenido(acta) {
  const votos = Object.keys(acta.votos)
    .sort()
    .map((k) => [k, acta.votos[k]]);
  const canonico = JSON.stringify([
    acta.municipio,
    acta.puesto,
    acta.mesa,
    votos,
    acta.sufragantes,
  ]);
  return createHash('sha256').update(canonico).digest('hex').slice(0, 32);
}

/** Lee la respuesta original guardada para una clave de idempotencia (depuración). */
export async function leerIdem(redis, clave) {
  const crudo = await redis.get(idem(clave));
  return crudo ? JSON.parse(crudo).r : null;
}

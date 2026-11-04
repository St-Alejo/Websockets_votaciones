// Dueño: Persona 1. FACHADA pública del dominio: las demás personas importan solo de aquí.
// Firmas: src/contratos/interfaces.js. Implementación sobre Redis en src/redis/.
// Errores que pueden lanzar (capturarlos): ErrorRedisNoDisponible, ErrorLimiteTasa.
import { topico as aTopico } from '../contratos/canales.js';
import { obtenerRedis } from '../redis/cliente.js';
import { aplicarVerificada, registrar } from '../redis/actas.js';
import { leerRanking, leerSnapshot } from '../redis/acumulados.js';
import { leerDesde } from '../redis/historial.js';
import { consumir } from '../redis/rateLimit.js';

export { ErrorLimiteTasa, ErrorRedisNoDisponible } from './errores.js';

// En globalThis por la misma razón que los clientes (ver src/redis/cliente.js).
const CONFIG = Symbol.for('preconteo.dominio.config');

/** Lo llama server.js al arrancar: instancia, límite de tasa y retención del stream. */
export function configurarDominio(config) {
  globalThis[CONFIG] = config;
}

export const configActual = () => globalThis[CONFIG] ?? null;

/** @type {import('../contratos/interfaces.js').registrarActa} */
export async function registrarActa(acta) {
  const c = configActual() ?? {};
  const redis = obtenerRedis();
  return registrar(redis, acta, {
    instancia: c.instanceId,
    streamMaxlen: c.streamMaxlen,
    // El límite se cuenta por credencial de jurado, después de validar el JSON.
    antesDeRegistrar: c.rlMax
      ? (valida) => consumir(redis, valida.jurado, { max: c.rlMax, ventanaMs: c.rlVentanaMs })
      : undefined,
  });
}

/** @type {import('../contratos/interfaces.js').aplicarActaVerificada} */
export async function aplicarActaVerificada(acta, version) {
  return aplicarVerificada(obtenerRedis(), acta, version, {
    streamMaxlen: configActual()?.streamMaxlen,
  });
}

/** @type {import('../contratos/interfaces.js').leerAcumulado} */
export async function leerAcumulado(nivel, id) {
  const t = aTopico(nivel, id);
  const { niveles } = await leerSnapshot(obtenerRedis(), [t]);
  return niveles[t];
}

/** @type {import('../contratos/interfaces.js').ranking} */
export async function ranking(nivel, id, topN) {
  return leerRanking(obtenerRedis(), nivel, id, topN);
}

/** @type {import('../contratos/interfaces.js').snapshot} */
export async function snapshot(niveles) {
  return leerSnapshot(obtenerRedis(), niveles);
}

/** @type {import('../contratos/interfaces.js').leerHistorialDesde} */
export async function leerHistorialDesde(streamId, max) {
  return leerDesde(obtenerRedis(), streamId, max);
}

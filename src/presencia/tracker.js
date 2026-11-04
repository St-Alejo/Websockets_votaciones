// Dueño: Persona 3. Presencia distribuida de auditores (RF-8).
// Redis STRING `presencia:{auditor}` con expiración (SET EX) renovada por latido.
// El valor es JSON: { auditor, estado, instancia, acta_actual, desde, latido }.
//
// Diseño para 120 auditores en 8 instancias:
// - La expiración de Redis es el mecanismo de respaldo: si una instancia muere
//   sin avisar (sin WS close), la clave expira sola y el auditor desaparece.
// - NO se depende solo del evento WS `close`.
// - El listado usa SCAN con MATCH `presencia:*` (120 claves: barato, sin recorrer
//   todo Redis). No se crea una clave índice adicional para no ampliar el contrato
//   de claves compartidas; si el volumen creciera se añadiría un ZSET índice.
// - Fantasma = registro cuyo `latido` supera el umbral sin renovarse (p. ej. la
//   instancia dejó de latir pero la clave aún no expiró). detectarFantasmas los
//   encuentra y purgarExpirados los borra + publica `offline`.

import { CANALES } from '../contratos/canales.js';
import { presencia as clavePresencia } from '../contratos/keys.js';
import { obtenerRedis } from '../redis/cliente.js';

/** TTL por defecto de presencia: 45 s (latido recomendado cada 15 s). */
export const TTL_S_PRESENCIA = 45;

/** Umbral por defecto para considerar fantasma: 60 s sin latido. */
export const UMBRAL_FANTASMA_MS = 60_000;

function cliente(redisExplicito) {
  const r = redisExplicito ?? obtenerRedis();
  if (!r) throw new Error('Redis no disponible: presencia requiere Redis');
  return r;
}

function validarAuditor(auditor) {
  if (typeof auditor !== 'string' || auditor.trim() === '') {
    throw new Error('auditor debe ser un string no vacío');
  }
}

function ahora() {
  return Date.now();
}

function parsear(crudo) {
  if (crudo === null || crudo === undefined) return null;
  try {
    const o = typeof crudo === 'string' ? JSON.parse(crudo) : crudo;
    if (!o || typeof o.auditor !== 'string') return null;
    return {
      auditor: o.auditor,
      estado: o.estado === 'offline' ? 'offline' : 'online',
      instancia: typeof o.instancia === 'string' ? o.instancia : 'desconocida',
      acta_actual:
        typeof o.acta_actual === 'string' || o.acta_actual === null
          ? (o.acta_actual ?? null)
          : null,
      desde: Number(o.desde) || ahora(),
      latido: Number(o.latido) || Number(o.desde) || ahora(),
    };
  } catch {
    return null;
  }
}

async function publicar(redis, evento) {
  try {
    if (!redis || typeof redis.publish !== 'function') return;
    if (redis.status && redis.status !== 'ready') return;
    await redis.publish(CANALES.PRESENCIA, JSON.stringify(evento));
  } catch {
    /* aviso best-effort */
  }
}

async function leerRegistro(redis, auditor) {
  const crudo = await redis.get(clavePresencia(auditor));
  return parsear(crudo);
}

/** Lista todas las claves presencia:* vía SCAN (seguro con 120 auditores). */
async function listarClaves(redis) {
  const claves = [];
  let cursor = '0';
  do {
    const [siguiente, lote] = await redis.scan(cursor, 'MATCH', 'presencia:*', 'COUNT', 100);
    cursor = String(siguiente);
    for (const k of lote) claves.push(k);
  } while (cursor !== '0');
  return claves;
}

/**
 * Registra conexión (o re-conexión). Preserva `desde` si ya existía registro.
 * Devuelve el registro guardado.
 */
export async function registrar(auditor, opciones = {}, redisExplicito) {
  validarAuditor(auditor);
  const {
    instancia = 'desconocida',
    estado = 'online',
    acta_actual = null,
    ttlS = TTL_S_PRESENCIA,
  } = opciones;
  const redis = cliente(redisExplicito ?? opciones.redis);
  const ttl = Number(ttlS) || TTL_S_PRESENCIA;
  try {
    const previo = await leerRegistro(redis, auditor);
    const registro = {
      auditor,
      estado,
      instancia,
      acta_actual: acta_actual ?? previo?.acta_actual ?? null,
      desde: previo?.desde ?? ahora(),
      latido: ahora(),
    };
    await redis.set(clavePresencia(auditor), JSON.stringify(registro), 'EX', ttl);
    if (!previo || previo.estado === 'offline') {
      await publicar(redis, {
        auditor,
        estado: 'online',
        instancia,
        acta_actual: registro.acta_actual,
        desde: registro.desde,
      });
    }
    return registro;
  } catch (err) {
    throw new Error(`registrar(${auditor}) falló: ${err.message}`, { cause: err });
  }
}

/** Renueva el latido (misma firma que registrar; crea el registro si no existe). */
export async function latido(auditor, opciones = {}, redisExplicito) {
  return registrar(auditor, opciones, redisExplicito ?? opciones.redis);
}

/** Registro de un auditor o null si no está presente (expiró o salió). */
export async function obtener(auditor, redisExplicito) {
  validarAuditor(auditor);
  const redis = cliente(redisExplicito);
  try {
    return await leerRegistro(redis, auditor);
  } catch (err) {
    throw new Error(`obtener(${auditor}) falló: ${err.message}`, { cause: err });
  }
}

/** Todos los auditores con presencia vigente en cualquier instancia. */
export async function activos(redisExplicito) {
  const redis = cliente(redisExplicito);
  try {
    const claves = await listarClaves(redis);
    if (claves.length === 0) return [];
    const valores = await Promise.all(claves.map((k) => redis.get(k).catch(() => null)));
    return valores.map(parsear).filter(Boolean);
  } catch (err) {
    throw new Error(`activos() falló: ${err.message}`, { cause: err });
  }
}

/** Actualiza el estado (online/offline) preservando lo demás. */
export async function actualizarEstado(auditor, estado, redisExplicito) {
  validarAuditor(auditor);
  if (estado !== 'online' && estado !== 'offline')
    throw new Error('estado debe ser online|offline');
  const redis = cliente(redisExplicito);
  try {
    const previo = await leerRegistro(redis, auditor);
    if (!previo) return null;
    const registro = { ...previo, estado, latido: ahora() };
    await redis.set(clavePresencia(auditor), JSON.stringify(registro), 'EX', TTL_S_PRESENCIA);
    await publicar(redis, {
      auditor,
      estado,
      instancia: registro.instancia,
      acta_actual: registro.acta_actual,
      desde: registro.desde,
    });
    return registro;
  } catch (err) {
    throw new Error(`actualizarEstado(${auditor}) falló: ${err.message}`, { cause: err });
  }
}

/** Actualiza el acta que está verificando el auditor (o null si ninguna). */
export async function actualizarActa(auditor, acta_actual, redisExplicito) {
  validarAuditor(auditor);
  const redis = cliente(redisExplicito);
  try {
    const previo = await leerRegistro(redis, auditor);
    if (!previo) return null;
    const registro = { ...previo, acta_actual: acta_actual ?? null, latido: ahora() };
    await redis.set(clavePresencia(auditor), JSON.stringify(registro), 'EX', TTL_S_PRESENCIA);
    return registro;
  } catch (err) {
    throw new Error(`actualizarActa(${auditor}) falló: ${err.message}`, { cause: err });
  }
}

/**
 * Registra desconexión limpia: publica `offline` y borra la clave.
 * Devuelve true si había registro.
 */
export async function salir(auditor, redisExplicito) {
  validarAuditor(auditor);
  const redis = cliente(redisExplicito);
  try {
    const previo = await leerRegistro(redis, auditor);
    if (typeof redis.del === 'function') {
      await redis.del(clavePresencia(auditor));
    } else if (typeof redis.unlink === 'function') {
      await redis.unlink(clavePresencia(auditor));
    }
    if (previo) {
      await publicar(redis, {
        auditor,
        estado: 'offline',
        instancia: previo.instancia,
        desde: previo.desde,
      });
      return true;
    }
    return false;
  } catch (err) {
    throw new Error(`salir(${auditor}) falló: ${err.message}`, { cause: err });
  }
}

/**
 * Detecta conexiones fantasma: registros cuyo último latido supera el umbral.
 * No borra; solo reporta para que el coordinador decida.
 */
export async function detectarFantasmas(umbralMs = UMBRAL_FANTASMA_MS, redisExplicito) {
  const redis = cliente(redisExplicito);
  const umbral = Number(umbralMs) || UMBRAL_FANTASMA_MS;
  const lista = await activos(redis);
  const t = ahora();
  return lista.filter((r) => t - Number(r.latido) > umbral);
}

/**
 * Borra registros expirados por latido obsoleto (fantasmas) y publica `offline`.
 * La expiración TTL de Redis ya borra la mayoría; esto cubre el margen donde la
 * clave aún existe pero el auditor dejó de latir. Devuelve la lista purgada.
 */
export async function purgarExpirados(umbralMs = UMBRAL_FANTASMA_MS, redisExplicito) {
  const redis = cliente(redisExplicito);
  const fantasmas = await detectarFantasmas(umbralMs, redis);
  for (const f of fantasmas) {
    try {
      if (typeof redis.del === 'function') await redis.del(clavePresencia(f.auditor));
      await publicar(redis, {
        auditor: f.auditor,
        estado: 'offline',
        instancia: f.instancia,
        desde: f.desde,
      });
    } catch {
      /* sigue con el siguiente */
    }
  }
  return fantasmas;
}

// Dueño: Persona 3. Bloqueos distribuidos de actas (RF-7).
// Redis STRING `lock:acta:{id}` con SET NX PX. El valor es JSON:
//   {"auditor":"AUD-7","token":"uuid"}
// El token es el secreto de propiedad; el auditor permite mostrar quién la tiene.
//
// Seguridad (condición de carrera A/B):
// 1. A obtiene el bloqueo. 2. Expira. 3. B lo obtiene. 4. A intenta liberar el viejo.
// La liberación/renovación comparan el token en un script Lua (atómico). A no puede
// borrar el bloqueo de B porque su token ya no coincide. NUNCA se usa DEL directo.

import { randomUUID } from 'node:crypto';
import { lockActa } from '../contratos/keys.js';
import { obtenerRedis } from '../redis/cliente.js';

/** TTL por defecto del bloqueo: 30 s (igual que el stub previo). */
export const TTL_MS_BLOQUEO = 30_000;

/**
 * Lua: borra solo si el token coincide. Soporta valor JSON {token} o token plano
 * (compatibilidad con datos viejos). Devuelve 1 si liberó, 0 si no.
 */
export const LUA_LIBERAR = `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local ok = false
if string.sub(v, 1, 1) == '{' then
  local o = cjson.decode(v)
  if o and o.token == ARGV[1] then ok = true end
else
  if v == ARGV[1] then ok = true end
end
if ok then return redis.call('DEL', KEYS[1]) else return 0 end
`;

/**
 * Lua: renueva el TTL solo si el token coincide. Devuelve 1 si renovó, 0 si no.
 * PEXPIRE devuelve 1 si puso el TTL.
 */
export const LUA_RENOVAR = `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local ok = false
if string.sub(v, 1, 1) == '{' then
  local o = cjson.decode(v)
  if o and o.token == ARGV[1] then ok = true end
else
  if v == ARGV[1] then ok = true end
end
if not ok then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;

function cliente(redisExplicito) {
  const r = redisExplicito ?? obtenerRedis();
  if (!r) throw new Error('Redis no disponible: bloqueos requieren Redis');
  return r;
}

function validar(mapa) {
  for (const [nombre, valor] of Object.entries(mapa)) {
    if (typeof valor !== 'string' || valor.trim() === '') {
      throw new Error(`${nombre} debe ser un string no vacío`);
    }
  }
}

function parsearValor(crudo) {
  if (crudo === null || crudo === undefined) return null;
  if (typeof crudo === 'string' && crudo.startsWith('{')) {
    try {
      const o = JSON.parse(crudo);
      if (o && typeof o.token === 'string') {
        return { auditor: typeof o.auditor === 'string' ? o.auditor : null, token: o.token };
      }
    } catch {
      return null;
    }
  }
  return { auditor: null, token: String(crudo) };
}

/**
 * Intenta tomar el acta con un bloqueo exclusivo.
 * Devuelve { token, ttl_ms } si lo obtuvo, o null si ya está bloqueada.
 */
export async function intentarBloquear(acta, auditor, ttlMs = TTL_MS_BLOQUEO, redisExplicito) {
  validar({ acta, auditor });
  const ttl = Number(ttlMs) || TTL_MS_BLOQUEO;
  if (ttl <= 0) throw new Error('ttlMs debe ser positivo');
  const redis = cliente(redisExplicito);
  const token = randomUUID();
  const valor = JSON.stringify({ auditor, token });
  try {
    const res = await redis.set(lockActa(acta), valor, 'PX', ttl, 'NX');
    if (res !== 'OK') return null;
    return { token, ttl_ms: ttl };
  } catch (err) {
    throw new Error(`intentarBloquear(${acta}) falló: ${err.message}`, { cause: err });
  }
}

/** Propietario actual del bloqueo ({ auditor, token }) o null si no hay bloqueo. */
export async function consultarPropietario(acta, redisExplicito) {
  validar({ acta });
  const redis = cliente(redisExplicito);
  try {
    return parsearValor(await redis.get(lockActa(acta)));
  } catch (err) {
    throw new Error(`consultarPropietario(${acta}) falló: ${err.message}`, { cause: err });
  }
}

/** true si existe un bloqueo vigente para el acta. */
export async function bloqueoVigente(acta, redisExplicito) {
  validar({ acta });
  const redis = cliente(redisExplicito);
  try {
    if (typeof redis.exists === 'function') {
      return Number(await redis.exists(lockActa(acta))) === 1;
    }
    return (await redis.get(lockActa(acta))) !== null;
  } catch (err) {
    throw new Error(`bloqueoVigente(${acta}) falló: ${err.message}`, { cause: err });
  }
}

/**
 * Libera el bloqueo solo si `token` sigue siendo el dueño (Lua atómico).
 * Devuelve true si liberó, false si el bloqueo ya no le pertenece (o no existe).
 */
export async function liberarBloqueo(acta, token, redisExplicito) {
  validar({ acta, token });
  const redis = cliente(redisExplicito);
  try {
    const res = await redis.eval(LUA_LIBERAR, 1, lockActa(acta), token);
    return Number(res) === 1;
  } catch (err) {
    throw new Error(`liberarBloqueo(${acta}) falló: ${err.message}`, { cause: err });
  }
}

/**
 * Renueva el TTL solo si `token` sigue siendo el dueño (Lua atómico).
 * Devuelve true si renovó, false si el bloqueo se perdió o es de otro.
 */
export async function renovarBloqueo(acta, token, ttlMs = TTL_MS_BLOQUEO, redisExplicito) {
  validar({ acta, token });
  const ttl = Number(ttlMs) || TTL_MS_BLOQUEO;
  if (ttl <= 0) throw new Error('ttlMs debe ser positivo');
  const redis = cliente(redisExplicito);
  try {
    const res = await redis.eval(LUA_RENOVAR, 1, lockActa(acta), token, String(ttl));
    return Number(res) === 1;
  } catch (err) {
    throw new Error(`renovarBloqueo(${acta}) falló: ${err.message}`, { cause: err });
  }
}

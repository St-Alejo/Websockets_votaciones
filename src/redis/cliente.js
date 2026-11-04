// Dueño: Persona 1. Creación de clientes Redis y acceso a ellos desde los módulos de dominio.
// `redis` es para comandos normales; `redisSub` queda en modo suscriptor (SUBSCRIBE bloquea la conexión).
import { Redis } from 'ioredis';

let clientes = { redis: null, redisSub: null };

export function crearClientesRedis(url, opciones = {}) {
  const base = { maxRetriesPerRequest: 2, ...opciones };
  const redis = new Redis(url, { ...base, connectionName: 'app' });
  const redisSub = new Redis(url, { ...base, connectionName: 'sub' });
  return { redis, redisSub };
}

/** Lo llama server.js al arrancar. Los módulos que no reciben `app` usan obtenerRedis(). */
export function registrarClientes(nuevos) {
  clientes = nuevos;
}

export const obtenerRedis = () => clientes.redis;
export const obtenerRedisSub = () => clientes.redisSub;

/** PING con tiempo límite; true si Redis responde. */
export async function redisResponde(redis, timeoutMs = 500) {
  if (!redis) return false;
  let temporizador;
  const limite = new Promise((resolve) => {
    temporizador = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([redis.ping().then((r) => r === 'PONG'), limite]);
  } catch {
    return false;
  } finally {
    clearTimeout(temporizador);
  }
}

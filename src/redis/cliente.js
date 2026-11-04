// Dueño: Persona 1. Creación de clientes Redis y acceso a ellos desde los módulos de dominio.
//
// `redis`    → comandos normales. enableOfflineQueue:false + commandTimeout: si Redis no
//              está, el comando falla de inmediato (o a los commandTimeout ms si Redis está
//              colgado) en vez de quedar encolado y colgar la petición del jurado (RF-10).
// `redisSub` → modo suscriptor (SUBSCRIBE bloquea la conexión). Este SÍ usa cola offline y no
//              tiene timeout: un SUBSCRIBE hecho antes de conectar se envía al conectar, y
//              ioredis vuelve a suscribir solo tras cada reconexión (autoResubscribe).
import { Redis } from 'ioredis';
import { definirComandos } from './scripts.js';

// Registro en globalThis (no en una variable de módulo): si este archivo llega a cargarse dos
// veces (p. ej. autoload importa los plugins con import() nativo mientras vitest transforma
// server.js), ambas copias ven los mismos clientes.
const REGISTRO = Symbol.for('preconteo.redis.clientes');
globalThis[REGISTRO] ??= { redis: null, redisSub: null };

/** Reintento con backoff exponencial acotado y jitter para no sincronizar las 8 instancias. */
export function estrategiaReintento(intento) {
  const base = Math.min(100 * 2 ** Math.min(intento, 5), 2000);
  return base / 2 + Math.random() * (base / 2);
}

export function crearClientesRedis(url, opciones = {}) {
  const { commandTimeoutMs = 1000, ...resto } = opciones;
  const comun = { retryStrategy: estrategiaReintento, connectTimeout: 2000, ...resto };

  const redis = new Redis(url, {
    ...comun,
    connectionName: 'app',
    enableOfflineQueue: false,
    commandTimeout: commandTimeoutMs,
    maxRetriesPerRequest: 0,
  });
  definirComandos(redis);

  const redisSub = new Redis(url, { ...comun, connectionName: 'sub' });
  return { redis, redisSub };
}

/** Lo llama server.js al arrancar. Los módulos que no reciben `app` usan obtenerRedis(). */
export function registrarClientes(nuevos) {
  globalThis[REGISTRO] = nuevos;
}

export const obtenerRedis = () => globalThis[REGISTRO].redis;
export const obtenerRedisSub = () => globalThis[REGISTRO].redisSub;

/** Espera a que el cliente esté listo (útil en scripts y tests; con cola offline apagada). */
export function esperarListo(redis, timeoutMs = 5000) {
  if (redis.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      redis.off('ready', listo);
      reject(new Error(`Redis no estuvo listo en ${timeoutMs} ms`));
    }, timeoutMs);
    function listo() {
      clearTimeout(t);
      resolve();
    }
    redis.once('ready', listo);
  });
}

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

// Dueño: Persona 1. Configuración leída de variables de entorno (ver docs/persona1-redis.md).
import { hostname } from 'node:os';

let cache;

const numero = (valor, defecto) => {
  const n = Number(valor);
  return valor === undefined || valor === '' || Number.isNaN(n) ? defecto : n;
};

export function cargarConfig(env = process.env) {
  if (cache && env === process.env) return cache;
  const config = Object.freeze({
    port: numero(env.PORT, 3000),
    host: env.HOST ?? '0.0.0.0',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    // En docker compose cada réplica tiene un hostname distinto (id del contenedor).
    instanceId: env.INSTANCE_ID || hostname(),
    logLevel: env.LOG_LEVEL ?? 'info',
    // Tiempo máximo que esperamos a Redis por comando: acota el 503 de RF-10.
    redisCommandTimeoutMs: numero(env.REDIS_COMMAND_TIMEOUT_MS, 1000),
    // Límite de tasa por jurado: RL_MAX envíos por ventana fija de RL_VENTANA_MS.
    rlMax: numero(env.RL_MAX, 20),
    rlVentanaMs: numero(env.RL_VENTANA_MS, 60_000),
    // Retención de stream:actas (aprox., XADD MAXLEN ~). Cabe la jornada entera (~6.600).
    streamMaxlen: numero(env.STREAM_MAXLEN, 10_000),
  });
  if (env === process.env) cache = config;
  return config;
}

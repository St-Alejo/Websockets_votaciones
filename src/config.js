// Dueño: Persona 1. Configuración leída de variables de entorno (ver .env.example).
import { hostname } from 'node:os';

let cache;

export function cargarConfig(env = process.env) {
  if (cache && env === process.env) return cache;
  const config = Object.freeze({
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    // En docker compose cada réplica tiene un hostname distinto (id del contenedor).
    instanceId: env.INSTANCE_ID || hostname(),
    logLevel: env.LOG_LEVEL ?? 'info',
  });
  if (env === process.env) cache = config;
  return config;
}

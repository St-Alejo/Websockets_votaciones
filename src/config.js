import { hostname } from 'node:os';

let cache;

const number = (value, fallback) => {
  const n = Number(value);
  return value === undefined || value === '' || Number.isNaN(n) ? fallback : n;
};

export function loadConfig(env = process.env) {
  if (cache && env === process.env) return cache;
  const config = Object.freeze({
    port: number(env.PORT, 3000),
    host: env.HOST ?? '0.0.0.0',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    instanceId: env.INSTANCE_ID || hostname(),
    logLevel: env.LOG_LEVEL ?? 'info',
    redisCommandTimeoutMs: number(env.REDIS_COMMAND_TIMEOUT_MS, 1000),
    rlMax: number(env.RL_MAX, 20),
    rlWindowMs: number(env.RL_WINDOW_MS, 60_000),
    streamMaxlen: number(env.STREAM_MAXLEN, 10_000),
  });
  if (env === process.env) cache = config;
  return config;
}

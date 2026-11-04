// Dueño: Persona 1. Carga los scripts Lua de src/redis/scripts/ como comandos de ioredis.
// defineCommand usa EVALSHA y, si Redis responde NOSCRIPT (p. ej. tras reiniciar), reenvía
// el script completo con EVAL automáticamente. Todas las claves van en KEYS (nunca se
// construyen dentro del script) para que el diseño sea migrable a Redis Cluster.
import { readFileSync } from 'node:fs';

const leer = (nombre) => readFileSync(new URL(`./scripts/${nombre}.lua`, import.meta.url), 'utf8');

/** nombre del comando → { archivo, numberOfKeys } (sin numberOfKeys = variable, va primero). */
export const SCRIPTS = Object.freeze({
  registrarActaLua: { archivo: 'registrar', numberOfKeys: 12 },
  snapshotLua: { archivo: 'snapshot' },
  limiteTasaLua: { archivo: 'limite-tasa', numberOfKeys: 1 },
});

const fuentes = Object.fromEntries(
  Object.entries(SCRIPTS).map(([nombre, s]) => [nombre, leer(s.archivo)]),
);

export function definirComandos(redis) {
  for (const [nombre, s] of Object.entries(SCRIPTS)) {
    if (typeof redis[nombre] === 'function') continue;
    redis.defineCommand(nombre, { lua: fuentes[nombre], numberOfKeys: s.numberOfKeys });
  }
  return redis;
}

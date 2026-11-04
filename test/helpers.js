// Utilidades compartidas de los tests de humo.
import { construirApp } from '../src/server.js';

/** Cliente Redis falso: suficiente para arrancar la app sin un Redis real. */
export function redisFalso() {
  return {
    status: 'wait',
    ping: async () => 'PONG',
    quit: async () => 'OK',
    on() {
      return this;
    },
    // Forma que espera leerSnapshot: [hash, totalCatálogo] por nivel y el stream_id al final.
    async snapshotLua(...args) {
      const claves = args.slice(1);
      const niveles = Math.max(0, (claves.length - 1) / 2);
      const crudo = [];
      for (let i = 0; i < niveles; i += 1) {
        crudo.push([]);
        crudo.push('0');
      }
      crudo.push('0-0');
      return crudo;
    },
  };
}

export const CONFIG_TEST = Object.freeze({
  port: 0,
  host: '127.0.0.1',
  redisUrl: 'redis://localhost:6379',
  instanceId: 'test-1',
  logLevel: 'silent',
});

export function appDePrueba(extra = {}) {
  return construirApp({
    config: CONFIG_TEST,
    redis: redisFalso(),
    redisSub: redisFalso(),
    logger: false,
    ...extra,
  });
}

/** Ejemplo literal de la sección 3.1 del enunciado. */
export const ACTA_EJEMPLO = Object.freeze({
  acta: 'E14-176-0042-03',
  mesa: 4201,
  puesto: 176,
  municipio: 11,
  version: 1,
  jurado: 'JUR-88134',
  ts_cierre: 1793577600,
  votos: { C1: 184, C2: 97, C3: 311, BLANCO: 22, NULO: 9, NO_MARCADO: 4 },
  sufragantes: 627,
  hash_foto: '9f2c...',
  idem: '8f14e45fceea167a',
});

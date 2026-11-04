import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reiniciarTopicos } from '../../src/fanout/topics.js';
import { leerLag } from '../../src/metrics/event_loop_lag.js';
import {
  exponer,
  leerTablero,
  registrarPublicacion,
  reiniciarMetricas,
} from '../../src/metrics/dashboard.js';
import { appDePrueba } from '../../test/helpers.js';

describe('RT-7 tablero de métricas', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;

  beforeAll(async () => {
    app = await appDePrueba();
    await app.ready();
  });

  afterAll(async () => {
    reiniciarTopicos();
    await app.close();
  });

  beforeEach(() => {
    reiniciarMetricas();
    reiniciarTopicos();
  });

  it('mide lag del event loop, tasa, memoria por conexión y latencia del acta', () => {
    const lag = leerLag();
    expect(lag.mean_ms).toBeGreaterThanOrEqual(0);
    expect(lag.p99_ms).toBeGreaterThanOrEqual(0);
    expect(lag.max_ms).toBeGreaterThanOrEqual(0);

    const recibidoEn = Date.now() - 40;
    registrarPublicacion({ n: 4, recibidoEn, publicadoEn: Date.now() });
    const tablero = leerTablero({ instancia: 'inst-a', conexiones: 2 });
    expect(tablero.mensajes_por_segundo).toBe(4);
    expect(tablero.mensajes_emitidos_total).toBe(4);
    expect(tablero.latencia_acta_publicacion_ms).toBeGreaterThanOrEqual(40);
    expect(tablero.memoria_por_conexion_bytes).toBeGreaterThan(0);
    expect(tablero.event_loop_lag_ms).toBeGreaterThanOrEqual(0);

    const texto = exponer({ instancia: 'inst-a', conexiones: 2 });
    for (const nombre of [
      'preconteo_conexiones',
      'preconteo_mensajes_por_segundo',
      'preconteo_eventloop_lag_ms',
      'preconteo_memoria_por_conexion_bytes',
      'preconteo_latencia_acta_publicacion_ms',
    ]) {
      expect(texto).toContain(nombre);
    }
    expect(texto).toContain('preconteo_mensajes_por_segundo{instancia="inst-a"} 4');
    expect(texto).toContain('preconteo_conexiones{instancia="inst-a"} 2');
  });

  it('GET /metrics publica el tablero Prometheus de la instancia', async () => {
    const res = await app.inject('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    for (const nombre of [
      'preconteo_conexiones',
      'preconteo_mensajes_por_segundo',
      'preconteo_eventloop_lag_ms',
      'preconteo_memoria_por_conexion_bytes',
      'preconteo_latencia_acta_publicacion_ms',
    ]) {
      expect(res.body).toMatch(new RegExp(`${nombre}\\{instancia="test-1"\\} \\d`));
    }
  });
});

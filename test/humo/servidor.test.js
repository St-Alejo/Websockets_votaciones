import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ACTA_EJEMPLO, appDePrueba } from '../helpers.js';

describe('servidor', () => {
  let app;
  beforeAll(async () => {
    app = await appDePrueba();
    await app.ready();
  });
  afterAll(() => app.close());

  it('arranca y escucha en un puerto', async () => {
    const direccion = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${direccion}/instancia`);
    expect(res.status).toBe(200);
  });

  it('GET /instancia responde con el id y el header X-Instance-Id', async () => {
    const res = await app.inject('/instancia');
    expect(res.statusCode).toBe(200);
    expect(res.json().instancia).toBe('test-1');
    expect(res.headers['x-instance-id']).toBe('test-1');
  });

  it('GET /salud informa el estado de Redis', async () => {
    const res = await app.inject('/salud');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ estado: 'ok', redis: 'ok' });
  });

  it('todas las rutas llevan X-Instance-Id, incluso un 404', async () => {
    const res = await app.inject('/no-existe');
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-instance-id']).toBe('test-1');
  });

  it('autoload carga los plugins de las 3 personas', async () => {
    const rutas = app.printRoutes({ commonPrefix: false });
    for (const r of [
      '/actas',
      '/acumulado/',
      '/ranking/',
      '/sse/publico',
      '/metrics',
      '/ws/jurado',
      '/ws/auditor',
    ]) {
      expect(rutas).toContain(r);
    }
  });

  // El flujo registrada → duplicada necesita Redis real: ver src/plugins/core/actas.test.js.
  it('POST /actas con un acta inválida → 400 rechazada (se valida antes de tocar Redis)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/actas',
      payload: { ...ACTA_EJEMPLO, votos: {} },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ estado: 'rechazada', recibo: null });
  });

  // Los datos reales de /acumulado y /ranking se prueban con Redis en src/plugins/core/actas.test.js.
  it('GET /acumulado y /ranking validan el nivel antes de tocar Redis', async () => {
    expect((await app.inject('/acumulado/pais/1')).statusCode).toBe(400);
    expect((await app.inject('/ranking/mun')).statusCode).toBe(400);
  });
});

describe('autoload', () => {
  it('carga un plugin de prueba desde la carpeta indicada', async () => {
    const dir = fileURLToPath(new URL('../fixtures/plugins', import.meta.url));
    const app = await appDePrueba({ dirPlugins: dir });
    const res = await app.inject('/prueba/anidado');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, instancia: 'test-1' });
    expect(res.headers['x-instance-id']).toBe('test-1');
    await app.close();
  });
});

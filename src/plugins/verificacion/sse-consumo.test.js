// Dueño: Persona 3. Humo del transporte que consume el frontend público (RT-5).
// NO modifica código de Persona 2: verifica por HTTP que GET /sse/publico
// emite `event: snapshot` con `id:` (reanunable) y rechaza tópicos inválidos.
import { afterAll, describe, expect, it } from 'vitest';
import { construirApp } from '../../server.js';
import { esperarListo } from '../../redis/cliente.js';
import { hayRedis, urlConDb } from '../../redis/pruebas.helper.js';
import { CONFIG_TEST } from '../../../test/helpers.js';

// El snapshot sale de Redis (Persona 1): necesita un Redis real (base 15).
describe.skipIf(!(await hayRedis()))('RT-5 el público consume SSE con snapshot reanudable', () => {
  let app;
  let base;
  afterAll(async () => {
    await app?.close().catch(() => null);
  });

  it('emite event: snapshot con id y header X-Instance-Id', async () => {
    app = await construirApp({
      config: { ...CONFIG_TEST, redisUrl: urlConDb(15) },
      logger: false,
    });
    await esperarListo(app.redis);
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${app.server.address().port}`;

    const res = await fetch(`${base}/sse/publico?topico=dep`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('x-instance-id')).toBe('test-1');

    const lector = res.body.getReader();
    const dec = new TextDecoder();
    let texto = '';
    const limite = Date.now() + 5000;
    while (!texto.includes('event: snapshot') && Date.now() < limite) {
      const { done, value } = await lector.read();
      if (done) break;
      texto += dec.decode(value, { stream: true });
    }
    await lector.cancel();
    expect(texto).toMatch(/event: snapshot/);
    expect(texto).toMatch(/^id: /m); // reanudable con Last-Event-ID (RF-6)
    const datos = texto.split('data: ')[1];
    expect(JSON.parse(datos).niveles.dep).toMatchObject({ nivel: 'dep' });
  });

  it('rechaza tópicos inválidos sin colgar la conexión', async () => {
    const res = await app.inject('/sse/publico?topico=pais:1');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'topico_invalido' });
  });
});

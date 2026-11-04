import http from 'node:http';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { desuscribir, estadisticas, suscribir, suscriptores } from '../../src/fanout/index.js';
import {
  cleanup,
  conexionesDe,
  recorrer,
  reiniciarTopicos,
  subscribe,
  unsubscribe,
} from '../../src/fanout/topics.js';
import { CABECERAS_SSE, escribirEvento, iniciarLatido } from '../../src/transport/sse.js';
import { appDePrueba } from '../../test/helpers.js';

describe('RF-5 índice tópico → conexiones', () => {
  beforeEach(() => reiniciarTopicos());

  it('alta, baja y recorrido no mezclan tópicos', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    subscribe(a, 'mun:11');
    subscribe(a, 'pue:176');
    subscribe(b, 'mun:11');
    subscribe(a, 'mun:11');

    expect(conexionesDe('mun:11').size).toBe(2);
    expect([...conexionesDe('pue:176')]).toEqual([a]);
    expect(conexionesDe('mesa:1').size).toBe(0);

    const vistos = [];
    expect(recorrer('mun:11', (c) => vistos.push(c.id))).toBe(2);
    expect(vistos).toEqual(['a', 'b']);

    unsubscribe(a, 'mun:11');
    expect([...conexionesDe('mun:11')]).toEqual([b]);
    expect(conexionesDe('pue:176').has(a)).toBe(true);

    cleanup(a);
    expect(conexionesDe('pue:176').size).toBe(0);
    expect(conexionesDe('mun:11').has(b)).toBe(true);
    cleanup(b);
    expect(estadisticas().topicos).toBe(0);
  });

  it('la fachada conserva la firma y cuenta conexiones distintas', () => {
    expect(suscribir.length).toBe(2);
    expect(desuscribir.length).toBe(2);
    const conexion = { id: 1 };
    suscribir(conexion, 'dep');
    suscribir(conexion, 'mun:11');
    expect(suscriptores('dep').has(conexion)).toBe(true);
    expect(estadisticas()).toMatchObject({ topicos: 2, suscripciones: 2, conexiones: 1 });
    desuscribir(conexion, 'dep');
    desuscribir(conexion, 'mun:11');
    expect(estadisticas().suscripciones).toBe(0);
  });
});

describe('SSE: formato, headers y latido', () => {
  it('declara los headers de event-stream', () => {
    expect(CABECERAS_SSE['Content-Type']).toBe('text/event-stream');
    expect(CABECERAS_SSE['Cache-Control']).toContain('no-cache');
    expect(CABECERAS_SSE.Connection).toBe('keep-alive');
  });

  it('escribe un evento SSE con id', () => {
    const chunks = [];
    const res = {
      writableEnded: false,
      destroyed: false,
      write(chunk) {
        chunks.push(chunk);
        return true;
      },
    };
    escribirEvento(res, { evento: 'snapshot', datos: { a: 1 }, id: '3-0' });
    expect(chunks[0]).toBe('id: 3-0\nevent: snapshot\ndata: {"a":1}\n\n');
  });

  it('manda ping y destruye el socket si no drena', async () => {
    const pings = [];
    const res = {
      destroyed: false,
      writableEnded: false,
      writable: true,
      write(chunk) {
        pings.push(chunk);
        return true;
      },
    };
    const detener = iniciarLatido(res, 20);
    await new Promise((r) => setTimeout(r, 70));
    detener();
    expect(pings.some((c) => c.startsWith(': ping'))).toBe(true);

    const colgado = {
      destroyed: false,
      writableEnded: false,
      writable: true,
      destroyedCalled: false,
      write() {
        return false;
      },
      destroy() {
        this.destroyed = true;
        this.destroyedCalled = true;
      },
    };
    const detenerColgado = iniciarLatido(colgado, 10);
    await new Promise((r) => setTimeout(r, 80));
    detenerColgado();
    expect(colgado.destroyedCalled).toBe(true);
  });

  it('GET /sse/publico abre el stream con snapshot y rechaza un tópico inválido', async () => {
    const app = await appDePrueba();
    const malo = await app.inject('/sse/publico?topico=pais:1');
    expect(malo.statusCode).toBe(400);

    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { status, headers, cuerpo } = await new Promise((resolve, reject) => {
        const req = http.get(`${base}/sse/publico?topico=mun:11`, (res) => {
          let cuerpo = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            cuerpo += chunk;
            if (cuerpo.includes('event: snapshot')) {
              res.destroy();
              resolve({ status: res.statusCode, headers: res.headers, cuerpo });
            }
          });
          res.on('error', () => {
            if (cuerpo.includes('event: snapshot')) {
              resolve({ status: res.statusCode, headers: res.headers, cuerpo });
            }
          });
        });
        req.on('error', reject);
      });
      expect(status).toBe(200);
      expect(headers['content-type']).toContain('text/event-stream');
      expect(headers['cache-control']).toContain('no-cache');
      expect(headers.connection).toBe('keep-alive');
      expect(cuerpo).toContain('retry:');
      expect(cuerpo).toContain('event: snapshot');
      expect(cuerpo).toContain('"mun:11"');
    } finally {
      reiniciarTopicos();
      await app.close();
    }
  });
});

afterAll(() => reiniciarTopicos());

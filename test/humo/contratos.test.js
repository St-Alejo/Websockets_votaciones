import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { FIRMAS } from '../../src/contratos/interfaces.js';
import * as keys from '../../src/contratos/keys.js';
import { CANALES, parsearTopico, topico } from '../../src/contratos/canales.js';
import { camposStream, eventoDesdeEntrada } from '../../src/contratos/stream.js';

const raiz = join(import.meta.dirname, '..', '..');

describe('interfaces: cada fachada expone las funciones con la firma acordada', () => {
  for (const [modulo, funciones] of Object.entries(FIRMAS)) {
    it(modulo, async () => {
      const m = await import(pathToFileURL(join(raiz, modulo)).href);
      for (const [nombre, aridad] of Object.entries(funciones)) {
        expect(typeof m[nombre], `${modulo} → ${nombre}`).toBe('function');
        expect(m[nombre].length, `${modulo} → ${nombre}: nº de parámetros`).toBe(aridad);
      }
    });
  }
});

describe('keys', () => {
  it('construye los nombres acordados', () => {
    expect(keys.acta('E14-176-0042-03')).toBe('acta:E14-176-0042-03');
    expect(keys.actaVersiones('A')).toBe('acta:A:versiones');
    expect(keys.idem('k')).toBe('idem:k');
    expect(keys.acum('dep')).toBe('acum:dep');
    expect(keys.acum('mun', 11)).toBe('acum:mun:11');
    expect(keys.acum('pue', 176)).toBe('acum:pue:176');
    expect(keys.acum('mesa', 4201)).toBe('acum:mesa:4201');
    expect(keys.rank('mun', 11)).toBe('rank:mun:11');
    expect(keys.catalogo('pue', 176)).toBe('cat:pue:176:mesas');
    expect(keys.streamActas).toBe('stream:actas');
    expect(keys.colaVerificacion).toBe('cola:verificacion');
    expect(keys.lockActa('A')).toBe('lock:acta:A');
    expect(keys.presencia('AUD-1')).toBe('presencia:AUD-1');
    expect(keys.rateLimit('JUR-1', 123)).toBe('rl:JUR-1:123');
  });

  it('rechaza niveles inválidos o sin id', () => {
    expect(() => keys.acum('pais', 1)).toThrow();
    expect(() => keys.acum('mun')).toThrow();
  });
});

describe('canales y tópicos', () => {
  it('nombres de canales', () => {
    expect(CANALES).toEqual({
      ACTA_NUEVA: 'acta:nueva',
      VERIFICACION: 'verificacion',
      PRESENCIA: 'presencia',
    });
  });

  it('tópico ida y vuelta', () => {
    expect(topico('mun', 11)).toBe('mun:11');
    expect(parsearTopico('mun:11')).toEqual({ nivel: 'mun', id: '11' });
    expect(parsearTopico('dep')).toEqual({ nivel: 'dep', id: null });
    expect(() => parsearTopico('pais:1')).toThrow();
  });

  it('formato de entrada de stream ida y vuelta', () => {
    const e = {
      stream_id: '5-0',
      acta: 'E14-1-2-03',
      mun: 1,
      pue: 1,
      version: 2,
      tipo: 'correccion',
    };
    expect(eventoDesdeEntrada(['5-0', camposStream(e)])).toEqual(e);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ActaEntrante,
  EventoActaNueva,
  RespuestaRegistro,
  Snapshot,
  cumpleReglaContable,
} from '../../src/contratos/esquemas.js';
import { registrarActa, snapshot } from '../../src/dominio/index.js';
import { ACTA_EJEMPLO } from '../helpers.js';

describe('ActaEntrante', () => {
  it('acepta el ejemplo de la sección 3.1 del PDF', () => {
    expect(ActaEntrante.safeParse(ACTA_EJEMPLO).success).toBe(true);
  });

  it('el ejemplo del PDF cumple la regla contable', () => {
    expect(cumpleReglaContable(ACTA_EJEMPLO)).toBe(true);
  });

  it('detecta un acta que no cuadra (votos ≠ sufragantes)', () => {
    const noCuadra = { ...ACTA_EJEMPLO, sufragantes: 630 };
    // Estructuralmente válida, pero no cumple la regla → "dudosa", no "rechazada".
    expect(ActaEntrante.safeParse(noCuadra).success).toBe(true);
    expect(cumpleReglaContable(noCuadra)).toBe(false);
  });

  it.each([
    ['votos negativos', { votos: { ...ACTA_EJEMPLO.votos, C1: -1 } }],
    ['sin NO_MARCADO', { votos: { C1: 1, BLANCO: 0, NULO: 0 } }],
    ['clave de voto desconocida', { votos: { ...ACTA_EJEMPLO.votos, X: 3 } }],
    ['sin idem', { idem: undefined }],
    ['version 0', { version: 0 }],
    ['acta mal formada', { acta: 'ACTA-1' }],
  ])('rechaza un acta con %s', (_nombre, cambio) => {
    expect(ActaEntrante.safeParse({ ...ACTA_EJEMPLO, ...cambio }).success).toBe(false);
  });
});

describe('stubs respetan los esquemas', () => {
  it('registrarActa devuelve RespuestaRegistro válidas', async () => {
    const ok = await registrarActa({ ...ACTA_EJEMPLO, idem: 'humo-esquemas-0001' });
    expect(RespuestaRegistro.parse(ok).estado).toBe('registrada');

    const dudosa = await registrarActa({ ...ACTA_EJEMPLO, sufragantes: 1, idem: 'humo-esq-0002' });
    expect(RespuestaRegistro.parse(dudosa).estado).toBe('dudosa');

    const mala = await registrarActa({ acta: 'x' });
    expect(RespuestaRegistro.parse(mala).estado).toBe('rechazada');
  });

  it('snapshot devuelve un Snapshot válido y jerárquicamente coherente', async () => {
    const s = Snapshot.parse(await snapshot(['dep', 'mun:11', 'pue:176', 'mesa:4201']));
    const { dep, 'mun:11': mun, 'pue:176': pue, 'mesa:4201': mesa } = s.niveles;
    for (const [hijo, padre] of [
      [mesa, pue],
      [pue, mun],
      [mun, dep],
    ]) {
      for (const [c, v] of Object.entries(hijo.votos))
        expect(padre.votos[c]).toBeGreaterThanOrEqual(v);
    }
    expect(mesa.sufragantes).toBe(627);
  });

  it('EventoActaNueva valida el formato del emisor falso', () => {
    const e = {
      stream_id: '1730000000000-0',
      acta: 'E14-176-0042-03',
      mun: 11,
      pue: 176,
      version: 1,
      tipo: 'nueva',
    };
    expect(EventoActaNueva.safeParse(e).success).toBe(true);
    expect(EventoActaNueva.safeParse({ ...e, tipo: 'otra' }).success).toBe(false);
  });
});

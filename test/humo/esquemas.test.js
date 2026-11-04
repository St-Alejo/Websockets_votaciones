import { describe, expect, it } from 'vitest';
import {
  ActaEntrante,
  EventoActaNueva,
  RespuestaRegistro,
  Snapshot,
  cumpleReglaContable,
} from '../../src/contratos/esquemas.js';
import { registrarActa } from '../../src/dominio/index.js';
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
  // registrada/dudosa/duplicada necesitan Redis real: ver src/redis/actas.test.js (Persona 1).
  it('registrarActa rechaza JSON inválido con una RespuestaRegistro válida (sin Redis)', async () => {
    const mala = await registrarActa({ acta: 'x' });
    expect(RespuestaRegistro.parse(mala).estado).toBe('rechazada');
  });

  // snapshot() necesita Redis real: Snapshot.parse y la coherencia jerárquica se prueban en
  // src/redis/acumulados.test.js (Persona 1). Aquí solo el esquema.
  it('Snapshot acepta una fotografía bien formada', () => {
    const acum = {
      nivel: 'mun',
      id: '11',
      votos: { C1: 1 },
      sufragantes: 1,
      mesas_informadas: 1,
      mesas_totales: 4,
      porcentaje_informado: 25,
    };
    expect(Snapshot.safeParse({ niveles: { 'mun:11': acum }, stream_id: '1-0' }).success).toBe(
      true,
    );
    expect(Snapshot.safeParse({ niveles: {}, stream_id: 'x' }).success).toBe(false);
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

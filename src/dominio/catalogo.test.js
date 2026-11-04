import { afterAll, describe, expect, it } from 'vitest';
import { TOTALES, generarCatalogo, sembrarCatalogo, totalesCatalogo } from './catalogo.js';
import { clientePrueba, hayRedis } from '../redis/pruebas.helper.js';

describe('catálogo sintético', () => {
  const cat = generarCatalogo();

  it('tiene 40 municipios, 1.842 puestos y 6.400 mesas', () => {
    const puestos = cat.municipios.flatMap((m) => m.puestos);
    expect(cat.municipios).toHaveLength(TOTALES.municipios);
    expect(puestos).toHaveLength(TOTALES.puestos);
    expect(puestos.flatMap((p) => p.mesas)).toHaveLength(TOTALES.mesas);
    expect(cat.mesa.size).toBe(TOTALES.mesas);
    expect(puestos.every((p) => p.mesas.length >= 1)).toBe(true);
  });

  it('es determinista', () => {
    expect(totalesCatalogo(generarCatalogo())).toEqual(totalesCatalogo(cat));
    expect(totalesCatalogo(generarCatalogo(7))).not.toEqual(totalesCatalogo(cat));
  });

  it('los totales por municipio suman los de sus puestos y el departamento', () => {
    const t = Object.fromEntries(totalesCatalogo(cat));
    let dep = 0;
    for (const m of cat.municipios) {
      const suma = m.puestos.reduce((a, p) => a + t[`cat:pue:${p.id}:mesas`], 0);
      expect(t[`cat:mun:${m.id}:mesas`]).toBe(suma);
      dep += suma;
    }
    expect(t['cat:dep:mesas']).toBe(dep);
  });
});

describe.skipIf(!(await hayRedis()))('seed en Redis', () => {
  let redis;
  afterAll(() => redis?.quit());

  it('escribe los totales y es idempotente', async () => {
    redis = await clientePrueba(10);
    await redis.flushdb();
    const n = await sembrarCatalogo(redis);
    expect(await sembrarCatalogo(redis)).toBe(n);
    expect(await redis.dbsize()).toBe(n);
    expect(Number(await redis.get('cat:dep:mesas'))).toBe(6400);
  });
});

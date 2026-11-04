import { describe, expect, it } from 'vitest';
import {
  MAX_CONEXIONES,
  ejecutarEscenario,
  planificarCurva,
  resumenCurva,
} from '../../src/load_test/scenario.js';

describe('RT-8 curva de la jornada y conexiones', () => {
  it('concentra el 55 % del volumen en los primeros 40 minutos', () => {
    const plan = planificarCurva();
    const resumen = resumenCurva(plan);
    expect(plan.puntos).toHaveLength(240);
    expect(plan.puntos[0].actasPorMinuto).toBeGreaterThan(plan.puntos[40].actasPorMinuto);
    expect(resumen.fraccion).toBeCloseTo(0.55, 5);
    expect(resumen.total).toBeCloseTo(6400, 5);
    expect(MAX_CONEXIONES).toBe(20_000);
  });

  it('abre conexiones concurrentes y rechaza pasar de 20.000', async () => {
    await expect(ejecutarEscenario({ conexiones: 20_001, mantenerMs: 0 })).rejects.toThrow(/20/);
    const resultado = await ejecutarEscenario({ conexiones: 3, mantenerMs: 0 });
    expect(resultado.conteo).toEqual({ solicitadas: 3, abiertas: 3, errores: 0 });
  });
});

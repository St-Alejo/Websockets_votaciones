import { describe, expect, it } from 'vitest';
import {
  MAX_CONNECTIONS,
  curveSummary,
  planCurve,
  runScenario,
} from '../../src/load_test/scenario.js';

describe('RT-8 election day curve and connections', () => {
  it('concentrates 55 % of the volume in the first 40 minutes', () => {
    const plan = planCurve();
    const summary = curveSummary(plan);
    expect(plan.points).toHaveLength(240);
    expect(plan.points[0].talliesPerMinute).toBeGreaterThan(plan.points[40].talliesPerMinute);
    expect(summary.fraction).toBeCloseTo(0.55, 5);
    expect(summary.total).toBeCloseTo(6400, 5);
    expect(MAX_CONNECTIONS).toBe(20_000);
  });

  it('opens concurrent connections and rejects going over 20,000', async () => {
    await expect(runScenario({ connections: 20_001, holdMs: 0 })).rejects.toThrow(/20/);
    const result = await runScenario({ connections: 3, holdMs: 0 });
    expect(result.count).toEqual({ requested: 3, open: 3, errors: 0 });
  });
});

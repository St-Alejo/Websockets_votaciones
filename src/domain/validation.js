import { IncomingTally, balances } from '../contracts/schemas.js';

export { IncomingTally, balances };

export function validateTally(input) {
  const r = IncomingTally.safeParse(input);
  if (r.success) return { ok: true, tally: r.data };
  return {
    ok: false,
    reason: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
  };
}

export function imbalance(tally) {
  const sum = Object.values(tally.votes).reduce((a, b) => a + b, 0);
  return Math.abs(sum - tally.voters);
}

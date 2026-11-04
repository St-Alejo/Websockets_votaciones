import { describe, expect, it } from 'vitest';
import {
  IncomingTally,
  NewTallyEvent,
  RegisterResponse,
  Snapshot,
  balances,
} from '../../src/contracts/schemas.js';
import { registerTally } from '../../src/domain/index.js';
import { SAMPLE_TALLY } from '../helpers.js';

describe('IncomingTally', () => {
  it('accepts the example from section 3.1 of the PDF', () => {
    expect(IncomingTally.safeParse(SAMPLE_TALLY).success).toBe(true);
  });

  it('the PDF example satisfies the accounting rule', () => {
    expect(balances(SAMPLE_TALLY)).toBe(true);
  });

  it('detects a tally that does not balance (votes != voters)', () => {
    const unbalanced = { ...SAMPLE_TALLY, voters: 630 };
    expect(IncomingTally.safeParse(unbalanced).success).toBe(true);
    expect(balances(unbalanced)).toBe(false);
  });

  it.each([
    ['negative votes', { votes: { ...SAMPLE_TALLY.votes, C1: -1 } }],
    ['no UNMARKED', { votes: { C1: 1, BLANK: 0, NULL: 0 } }],
    ['unknown vote key', { votes: { ...SAMPLE_TALLY.votes, X: 3 } }],
    ['no idem', { idem: undefined }],
    ['version 0', { version: 0 }],
    ['malformed tally id', { tally: 'TALLY-1' }],
  ])('rejects a tally with %s', (_name, change) => {
    expect(IncomingTally.safeParse({ ...SAMPLE_TALLY, ...change }).success).toBe(false);
  });
});

describe('stubs respect the schemas', () => {
  it('registerTally rejects invalid JSON with a valid RegisterResponse (no Redis)', async () => {
    const bad = await registerTally({ tally: 'x' });
    expect(RegisterResponse.parse(bad).status).toBe('rejected');
  });

  it('Snapshot accepts a well-formed snapshot', () => {
    const totals = {
      level: 'mun',
      id: '11',
      votes: { C1: 1 },
      voters: 1,
      tables_reported: 1,
      tables_total: 4,
      percent_reported: 25,
    };
    expect(Snapshot.safeParse({ levels: { 'mun:11': totals }, stream_id: '1-0' }).success).toBe(
      true,
    );
    expect(Snapshot.safeParse({ levels: {}, stream_id: 'x' }).success).toBe(false);
  });

  it('NewTallyEvent validates the fake emitter format', () => {
    const e = {
      stream_id: '1730000000000-0',
      tally: 'E14-176-0042-03',
      mun: 11,
      station: 176,
      version: 1,
      type: 'new',
    };
    expect(NewTallyEvent.safeParse(e).success).toBe(true);
    expect(NewTallyEvent.safeParse({ ...e, type: 'other' }).success).toBe(false);
  });
});

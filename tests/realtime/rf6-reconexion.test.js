import { beforeEach, describe, expect, it } from 'vitest';
import { clearMemory, readSince, recordInMemory } from '../../src/redis/history.js';
import {
  affectsTopic,
  createReconnectClient,
  decideResume,
  exponentialBackoff,
  readCursor,
  retryDirective,
} from '../../src/transport/reconnection.js';

function event(partial) {
  return {
    stream_id: '1-0',
    tally: 'E14-176-0042-03',
    mun: 11,
    station: 176,
    version: 1,
    type: 'new',
    ...partial,
  };
}

describe('RF-6 cursor and resume', () => {
  beforeEach(() => clearMemory());

  it('reads Last-Event-ID before last_id', () => {
    expect(
      readCursor({
        headers: { 'last-event-id': '10-1' },
        query: { last_id: '1-0' },
      }),
    ).toBe('10-1');
    expect(readCursor({ headers: {}, query: { last_id: '8-0' } })).toBe('8-0');
    expect(readCursor({ headers: { 'last-event-id': '  ' }, query: {} })).toBeNull();
  });

  it('filters events by the topic hierarchy', () => {
    const ev = event();
    expect(affectsTopic(ev, 'dept')).toBe(true);
    expect(affectsTopic(ev, 'mun:11')).toBe(true);
    expect(affectsTopic(ev, 'mun:12')).toBe(false);
    expect(affectsTopic(ev, 'station:176')).toBe(true);
    expect(affectsTopic(ev, 'station:1')).toBe(false);
  });

  it('without a cursor, or with a trimmed stream, sends a snapshot', async () => {
    const snap = { levels: {}, stream_id: '50-0' };
    const snapshot = async () => snap;
    const noCursor = await decideResume({
      cursor: null,
      topic: 'mun:11',
      snapshot,
      history: { readSince: async () => ({ events: [] }) },
    });
    expect(noCursor).toMatchObject({ mode: 'snapshot', reason: 'no_cursor', snapshot: snap });

    const trimmed = await decideResume({
      cursor: '1-0',
      topic: 'dept',
      snapshot,
      history: {
        readSince: async () => ({ events: [], stream_id: '9-0', trimmed: true }),
      },
    });
    expect(trimmed).toMatchObject({ mode: 'snapshot', reason: 'history_trimmed' });

    const gap = await decideResume({
      cursor: '1-0',
      topic: 'dept',
      maxDeltas: 2,
      snapshot,
      history: {
        readSince: async () => ({
          events: [event({ stream_id: '2-0' }), event({ stream_id: '3-0' })],
          stream_id: '3-0',
          trimmed: false,
          hasMore: true,
        }),
      },
    });
    expect(gap.mode).toBe('snapshot');
    expect(gap.reason).toBe('gap_too_large');
  });

  it('resends only the missing deltas of the topic', async () => {
    const plan = await decideResume({
      cursor: '5-0',
      topic: 'mun:11',
      maxDeltas: 10,
      snapshot: async () => {
        throw new Error('should not have requested a snapshot');
      },
      history: {
        readSince: async (cursor, max) => {
          expect(cursor).toBe('5-0');
          expect(max).toBe(10);
          return {
            events: [
              event({ stream_id: '6-0', mun: 11 }),
              event({ stream_id: '7-0', mun: 99, station: 2, tally: 'E14-002-0001-03' }),
            ],
            stream_id: '7-0',
            trimmed: false,
            hasMore: false,
          };
        },
      },
    });
    expect(plan.mode).toBe('deltas');
    expect(plan.events.map((e) => e.stream_id)).toEqual(['6-0']);
  });

  it('the history stub distinguishes trimmed, up to date and has more', async () => {
    recordInMemory(event({ stream_id: '10-0' }));
    expect((await readSince('1-0', 10)).trimmed).toBe(true);

    clearMemory();
    recordInMemory(event({ stream_id: '5-0' }));
    recordInMemory(event({ stream_id: '6-0', mun: 4 }));
    const upToDate = await readSince('6-0', 10);
    expect(upToDate.events).toEqual([]);
    expect(upToDate.trimmed).toBe(false);

    recordInMemory(event({ stream_id: '7-0' }));
    const page = await readSince('5-0', 1);
    expect(page.events.map((e) => e.stream_id)).toEqual(['6-0']);
    expect(page.hasMore).toBe(true);

    const plan = await decideResume({
      cursor: '5-0',
      topic: 'dept',
      maxDeltas: 1,
      snapshot: async () => ({ levels: {}, stream_id: '9-0' }),
    });
    expect(plan.mode).toBe('snapshot');
  });
});

describe('RF-10 backoff with jitter', () => {
  it('the ceiling grows exponentially and jitter spreads the waits', () => {
    const low = exponentialBackoff({
      attempt: 0,
      baseMs: 1000,
      maxMs: 30_000,
      random: () => 0,
    });
    const high = exponentialBackoff({
      attempt: 0,
      baseMs: 1000,
      maxMs: 30_000,
      random: () => 0.999,
    });
    expect(low.ceilingMs).toBe(1000);
    expect(low.waitMs).toBe(500);
    expect(high.waitMs).toBeGreaterThan(low.waitMs);
    expect(high.waitMs).toBeLessThanOrEqual(1000);

    expect(
      exponentialBackoff({ attempt: 3, baseMs: 1000, maxMs: 30_000, random: () => 0 }).ceilingMs,
    ).toBe(8000);
    expect(
      exponentialBackoff({ attempt: 20, baseMs: 1000, maxMs: 30_000, random: () => 0 }).ceilingMs,
    ).toBe(30_000);

    const waits = new Set(
      Array.from(
        { length: 30 },
        (_, i) =>
          exponentialBackoff({
            attempt: 4,
            baseMs: 1000,
            maxMs: 30_000,
            random: () => (i + 1) / 31,
          }).waitMs,
      ),
    );
    expect(waits.size).toBeGreaterThan(10);

    const retries = new Set(
      Array.from({ length: 20 }, (_, i) => retryDirective(() => (i + 1) / 21)),
    );
    expect(retries.size).toBeGreaterThan(5);
  });

  it('the client retries with growing waits and settles once connected', async () => {
    let failures = 0;
    const scheduled = [];
    const client = createReconnectClient({
      connect: async () => {
        failures += 1;
        if (failures < 3) throw new Error('down');
      },
      baseMs: 100,
      maxMs: 10_000,
      random: () => 0.5,
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
        return scheduled.length;
      },
      cancel() {},
    });

    await client.start();
    expect(scheduled).toHaveLength(1);
    await scheduled[0].fn();
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1].ms).toBeGreaterThan(scheduled[0].ms);
    await scheduled[1].fn();
    expect(client.attempt).toBe(0);
    expect(failures).toBe(3);
  });
});

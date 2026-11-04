import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/fanout/engine.js';

function tally(partial = {}) {
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

function engineWith({ connections, topic = 'mun:11', ...rest }) {
  let tick = null;
  const queue = [];
  const engine = createEngine({
    batchSize: 10,
    windowMs: 25,
    schedule(fn) {
      tick = fn;
      return 1;
    },
    cancel() {
      tick = null;
    },
    yieldControl(fn) {
      queue.push(fn);
    },
    resolveConnections(t) {
      return t === topic ? connections : [];
    },
    ...rest,
  });
  return {
    engine,
    queue,
    flush() {
      if (!tick) throw new Error('no pending window');
      const fn = tick;
      tick = null;
      fn();
    },
  };
}

describe('RF-4 batched and windowed fan-out', () => {
  it('the default yield is setImmediate', () => {
    expect(createEngine().yieldControl).toBe(setImmediate);
  });

  it('sends in batches of N and only yields the event loop between batches', () => {
    const received = [];
    const connections = Array.from({ length: 5 }, (_, i) => ({
      send() {
        received.push(i);
      },
    }));
    const queue = [];
    let tick = null;
    const engine = createEngine({
      batchSize: 2,
      windowMs: 20,
      schedule(fn) {
        tick = fn;
        return 1;
      },
      cancel() {
        tick = null;
      },
      yieldControl(fn) {
        queue.push(fn);
      },
      resolveConnections: (t) => (t === 'dept' ? connections : []),
    });

    engine.ingest(tally());
    expect(received).toEqual([]);
    tick();
    expect(received).toEqual([0, 1]);
    expect(queue).toHaveLength(1);
    queue.shift()();
    expect(received).toEqual([0, 1, 2, 3]);
    queue.shift()();
    expect(received).toEqual([0, 1, 2, 3, 4]);
    expect(queue).toHaveLength(0);
    expect(engine.stats().yields).toBe(2);
  });

  it('collapses repetitions of the same tally into a single delta', () => {
    const sent = [];
    const connection = {
      send(_event, data) {
        sent.push(data);
      },
    };
    const { engine, flush } = engineWith({ connections: [connection] });
    engine.ingest(tally({ version: 1, stream_id: '1-0' }));
    engine.ingest(tally({ version: 3, type: 'correction', stream_id: '3-0' }));
    engine.ingest(tally({ version: 2, type: 'correction', stream_id: '2-0' }));
    flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].events).toHaveLength(1);
    expect(sent[0].events[0]).toMatchObject({ version: 3, stream_id: '3-0' });
    expect(engine.stats()).toMatchObject({ naiveMessages: 3, messagesSent: 1 });
  });

  it('several tallies in the window go out in one message, not one per tally', () => {
    const received = [];
    const connections = [0, 1, 2].map(() => ({
      send(_event, data) {
        received.push(data.events.length);
      },
    }));
    const { engine, flush } = engineWith({ connections });
    for (let n = 0; n < 4; n += 1) {
      engine.ingest(
        tally({
          tally: `E14-176-000${n}-03`,
          stream_id: `${n + 1}-0`,
        }),
      );
    }
    flush();
    expect(received).toEqual([4, 4, 4]);
    expect(engine.stats().naiveMessages).toBe(12);
    expect(engine.stats().messagesSent).toBe(3);
  });

  it('holds deltas while the connection is not ready and then delivers them', () => {
    const sent = [];
    const connection = {
      accepts: false,
      held: [],
      send(_event, data) {
        sent.push(data);
      },
    };
    const { engine, flush } = engineWith({ connections: [connection], topic: 'dept' });
    engine.ingest(tally());
    flush();
    expect(sent).toEqual([]);
    expect(connection.held).toHaveLength(1);
    connection.accepts = true;
    engine.deliver(connection, connection.held.shift());
    expect(sent).toHaveLength(1);
    expect(sent[0].topic).toBe('dept');
  });
});

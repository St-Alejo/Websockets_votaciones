import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerClients } from '../../src/redis/client.js';
import { hasRedis, testClient } from '../../src/redis/test.helper.js';
import { evaluate, readPending } from '../../src/fanout/backpressure.js';
import { createEngine } from '../../src/fanout/engine.js';
import { checkPressure } from '../../src/fanout/index.js';
import { resetTopics } from '../../src/fanout/topics.js';

const thresholds = { suspend: 100, disconnect: 1000 };

function tally(stream_id = '1-0') {
  return {
    stream_id,
    tally: 'E14-176-0042-03',
    mun: 11,
    station: 176,
    version: 1,
    type: 'new',
  };
}

const WITH_REDIS = await hasRedis();
let realRedis;
afterAll(() => realRedis?.quit());

describe('RF-9 backpressure', () => {
  beforeEach(() => resetTopics());

  it('classifies delta, suspension, snapshot and disconnection', () => {
    const connection = { bufferedAmount: 50, needsSnapshot: false };
    expect(readPending(connection)).toBe(50);
    expect(evaluate(connection, thresholds).action).toBe('delta');

    connection.bufferedAmount = 100;
    expect(evaluate(connection, thresholds).action).toBe('suspend');

    connection.bufferedAmount = 0;
    connection.needsSnapshot = true;
    expect(evaluate(connection, thresholds).action).toBe('snapshot');

    connection.bufferedAmount = 1000;
    expect(evaluate(connection, thresholds).action).toBe('disconnect');

    const viaSocket = { socket: { writableLength: 40 } };
    expect(readPending(viaSocket)).toBe(40);
  });

  it('suspends deltas, sends a snapshot once stable and cuts off the slow client', () => {
    const connection = {
      bufferedAmount: 200,
      sent: [],
      send(event) {
        this.sent.push(event);
      },
      close(reason) {
        this.reason = reason;
      },
    };
    const snapshots = [];
    let tick = null;
    const engine = createEngine({
      batchSize: 10,
      windowMs: 10,
      schedule(fn) {
        tick = fn;
        return 1;
      },
      cancel() {
        tick = null;
      },
      yieldControl(fn) {
        fn();
      },
      resolveConnections: (t) => (t === 'mun:11' ? [connection] : []),
      evaluate: (c) => evaluate(c, thresholds),
      sendSnapshot(c) {
        snapshots.push(c);
        c.send('snapshot', { ok: true });
      },
      onDisconnect(c) {
        c.close('slow');
      },
    });

    engine.ingest(tally('1-0'));
    tick();
    expect(connection.sent).toEqual([]);
    expect(connection.needsSnapshot).toBe(true);
    expect(snapshots).toHaveLength(0);

    connection.bufferedAmount = 0;
    engine.ingest(tally('2-0'));
    tick();
    expect(snapshots).toHaveLength(1);
    expect(connection.sent).toEqual(['snapshot']);
    expect(connection.needsSnapshot).toBe(false);

    connection.bufferedAmount = 5000;
    engine.ingest(tally('3-0'));
    tick();
    expect(connection.reason).toBe('slow');
    expect(connection.closed).toBe(true);
    expect(connection.sent).toEqual(['snapshot']);
  });

  it.skipIf(!WITH_REDIS)('the heartbeat forces the snapshot once the buffer drops', async () => {
    realRedis = await testClient(14);
    registerClients({ redis: realRedis, redisSub: null });
    const connection = {
      topic: 'dept',
      bufferedAmount: 0,
      needsSnapshot: true,
      sent: [],
      send(event, data) {
        this.sent.push({ event, data });
      },
    };
    checkPressure(connection);
    expect(connection.needsSnapshot).toBe(false);
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    expect(connection.sent[0]?.event).toBe('snapshot');
    expect(connection.sent[0]?.data.stream_id).toBeTruthy();
  });
});

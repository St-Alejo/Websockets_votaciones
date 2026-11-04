import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineQueue, STATUSES } from './offlineQueue.js';

function memory() {
  const map = new Map();
  return {
    async put(e) {
      map.set(e.id, { ...e });
    },
    async get(id) {
      return map.get(id) ?? null;
    },
    async getAll() {
      return [...map.values()];
    },
  };
}

const tally = (idemExtra = {}) => ({
  tally: 'E14-176-4201-3',
  table: 4201,
  station: 176,
  municipality: 11,
  version: 1,
  juror: 'JUR-1',
  closed_at: 1793577600,
  votes: { C1: 184, C2: 97, C3: 311, BLANK: 22, NULL: 9, UNMARKED: 4 },
  voters: 627,
  photo_hash: 'x',
  idem: 'idem-test',
  ...idemExtra,
});

const noWait = (ms) => {
  noWait.calls.push(ms);
  return Promise.resolve();
};
noWait.calls = [];

describe('RT-6 offline queue', () => {
  it('save creates a persisted PENDING with a unique idem', async () => {
    const queue = createOfflineQueue({ storage: memory(), wait: noWait });
    const e = await queue.save(tally());
    assert.equal(e.status, STATUSES.PENDING);
    assert.ok(e.idem);
    assert.equal((await queue.list()).length, 1);
  });

  it('process confirms only with the server ACK', async () => {
    const queue = createOfflineQueue({ storage: memory(), wait: noWait });
    await queue.save(tally());
    await queue.process({
      canSend: () => true,
      send: async () => ({ status: 'registered', tally: 'E14-176-4201-3', version: 1, receipt: 'R1' }),
    });
    const [e] = await queue.list();
    assert.equal(e.status, STATUSES.ACKNOWLEDGED);
    assert.equal(e.response.receipt, 'R1');
  });

  it('network failure: progressive backoff and FAILED after exhausting attempts (never deleted)', async () => {
    const delay = [];
    const queue = createOfflineQueue({
      storage: memory(),
      wait: (ms) => {
        delay.push(ms);
        return Promise.resolve();
      },
      baseMs: 1000,
      maxMs: 8000,
      maxAttempts: 3,
    });
    await queue.save(tally());
    await queue.process({
      canSend: () => true,
      send: async () => {
        throw new Error('network down');
      },
    });
    assert.equal(delay.length, 2);
    assert.ok(delay[0] >= 2000 && delay[0] < 2600, `d1=${delay[0]}`);
    assert.ok(delay[1] >= 4000 && delay[1] < 4600, `d2=${delay[1]}`);
    const [e] = await queue.list();
    assert.equal(e.status, STATUSES.FAILED);
    assert.equal(e.attempts, 3);
    assert.match(e.lastError, /network down/);
  });

  it('failure then success: retries with the same idem and confirms', async () => {
    const queue = createOfflineQueue({ storage: memory(), wait: noWait, maxAttempts: 5 });
    const g = await queue.save(tally());
    let call = 0;
    await queue.process({
      canSend: () => true,
      send: async (submission) => {
        call += 1;
        assert.equal(submission.idem, g.idem);
        if (call === 1) throw new Error('brief outage');
        return { status: 'registered', tally: submission.tally.tally, version: 1, receipt: 'R2' };
      },
    });
    assert.equal(call, 2);
    const [e] = await queue.list();
    assert.equal(e.status, STATUSES.ACKNOWLEDGED);
    assert.equal(e.attempts, 1);
  });

  it('retries reuse the SAME idem (no duplicates on the server)', async () => {
    const idems = [];
    const queue = createOfflineQueue({ storage: memory(), wait: noWait });
    const g = await queue.save(tally());
    let call = 0;
    await queue.process({
      canSend: () => true,
      send: async (submission) => {
        idems.push(submission.idem);
        call += 1;
        if (call === 1) throw new Error('outage');
        return { status: 'duplicate', tally: submission.tally.tally, version: 1, receipt: 'R1' };
      },
    });
    assert.equal(idems[0], g.idem);
    await queue.process({
      canSend: () => true,
      send: async (submission) => {
        idems.push(submission.idem);
        return { status: 'duplicate', tally: submission.tally.tally, version: 1, receipt: 'R1' };
      },
    });
    assert.deepEqual(idems, [g.idem, g.idem]);
    const [e] = await queue.list();
    assert.equal(e.status, STATUSES.ACKNOWLEDGED);
  });

  it('without transport nothing is touched', async () => {
    const queue = createOfflineQueue({ storage: memory(), wait: noWait });
    await queue.save(tally());
    let calls = 0;
    await queue.process({ canSend: () => false, send: async () => calls++ });
    assert.equal(calls, 0);
    assert.equal((await queue.list())[0].status, STATUSES.PENDING);
  });

  it('rejected → FAILED with reason and no automatic retry', async () => {
    const queue = createOfflineQueue({ storage: memory(), wait: noWait });
    await queue.save(tally());
    await queue.process({
      canSend: () => true,
      send: async () => ({ status: 'rejected', tally: 'x', version: 0, receipt: null, reason: 'votes: missing' }),
    });
    const [e] = await queue.list();
    assert.equal(e.status, STATUSES.FAILED);
    assert.match(e.lastError, /votes/);
  });

  it('reloading recovers the PENDING items from the same storage', async () => {
    const st = memory();
    const q1 = createOfflineQueue({ storage: st, wait: noWait });
    await q1.save(tally());
    const q2 = createOfflineQueue({ storage: st, wait: noWait });
    assert.equal((await q2.list()).length, 1);
    await q2.process({
      canSend: () => true,
      send: async () => ({ status: 'registered', tally: 'E14-176-4201-3', version: 1, receipt: 'R9' }),
    });
    assert.equal((await q2.list())[0].response.receipt, 'R9');
  });

  it('retry moves FAILED back to PENDING', async () => {
    const queue = createOfflineQueue({ storage: memory(), wait: noWait });
    const g = await queue.save(tally());
    await queue.process({
      canSend: () => true,
      send: async () => ({ status: 'rejected', tally: 'x', version: 0, receipt: null }),
    });
    assert.equal((await queue.get(g.id)).status, STATUSES.FAILED);
    await queue.retry(g.id);
    assert.equal((await queue.get(g.id)).status, STATUSES.PENDING);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { waitUntilReady } from '../../redis/client.js';
import { hasRedis, urlWithDb } from '../../redis/test.helper.js';
import { buildApp } from '../../server.js';
import { SAMPLE_TALLY, TEST_CONFIG } from '../../../test/helpers.js';
import { enqueueTally, queueSize } from '../../verification/queue.js';
import { viewQueue } from '../../verification/index.js';

function createFakeCluster() {
  const zsets = new Map();
  const strings = new Map();
  const handlers = new Set();

  function live(key) {
    const e = strings.get(key);
    if (!e) return null;
    if (e.expiresMs !== null && Date.now() >= e.expiresMs) {
      strings.delete(key);
      return null;
    }
    return e;
  }

  function tokenOk(raw, token) {
    if (raw.startsWith('{')) {
      try {
        return JSON.parse(raw).token === token;
      } catch {
        return false;
      }
    }
    return raw === token;
  }

  function base() {
    return {
      status: 'ready',
      on() {
        return this;
      },
      async ping() {
        return 'PONG';
      },
      async quit() {
        return 'OK';
      },
      async zadd(key, ...args) {
        let nx = false;
        let xx = false;
        while (args.length > 2 && typeof args[0] === 'string') {
          const opt = args.shift().toUpperCase();
          if (opt === 'NX') nx = true;
          else if (opt === 'XX') xx = true;
        }
        const [score, member] = args;
        let m = zsets.get(key);
        if (!m) {
          m = new Map();
          zsets.set(key, m);
        }
        const exists = m.has(member);
        if (nx && exists) return 0;
        if (xx && !exists) return 0;
        m.set(member, Number(score));
        return exists ? 0 : 1;
      },
      async zscore(key, member) {
        const v = zsets.get(key)?.get(member);
        return v === undefined ? null : String(v);
      },
      async zrevrange(key, start, stop, withscores) {
        const m = zsets.get(key);
        if (!m) return [];
        const order = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
        const slice = order.slice(start, stop + 1);
        if (String(withscores).toUpperCase() === 'WITHSCORES') {
          return slice.flatMap(([member, score]) => [member, String(score)]);
        }
        return slice.map(([member]) => member);
      },
      async zcard(key) {
        return zsets.get(key)?.size ?? 0;
      },
      async zrem(key, member) {
        const m = zsets.get(key);
        if (!m || !m.has(member)) return 0;
        m.delete(member);
        return 1;
      },
      async set(key, value, ...args) {
        let nx = false;
        let ms = null;
        for (let i = 0; i < args.length; i++) {
          const a = String(args[i]).toUpperCase();
          if (a === 'NX') nx = true;
          else if (a === 'PX') ms = Number(args[++i]);
          else if (a === 'EX') ms = Number(args[++i]) * 1000;
        }
        if (nx && live(key)) return null;
        strings.set(key, { value: String(value), expiresMs: ms ? Date.now() + ms : null });
        return 'OK';
      },
      async get(key) {
        return live(key)?.value ?? null;
      },
      async exists(key) {
        return live(key) ? 1 : 0;
      },
      async del(key) {
        return strings.delete(key) ? 1 : 0;
      },
      async eval(script, numkeys, ...args) {
        const keys = args.slice(0, numkeys);
        const argv = args.slice(numkeys);
        const e = live(keys[0]);
        if (script.includes('PEXPIRE')) {
          const [token, ttl] = argv;
          if (!e || !tokenOk(e.value, token)) return 0;
          e.expiresMs = Date.now() + Number(ttl);
          return 1;
        }
        const [token] = argv;
        if (!e || !tokenOk(e.value, token)) return 0;
        strings.delete(keys[0]);
        return 1;
      },
      async scan(_cursor, ...args) {
        let match = '*';
        for (let i = 0; i < args.length; i++) {
          if (String(args[i]).toUpperCase() === 'MATCH') match = args[++i];
        }
        const rx = new RegExp(
          `^${match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
        );
        return ['0', [...strings.keys()].filter((k) => rx.test(k) && live(k))];
      },
      async publish(channel, message) {
        const text = typeof message === 'string' ? message : JSON.stringify(message);
        for (const h of [...handlers]) setImmediate(() => h(channel, text));
        return 1;
      },
    };
  }

  return {
    newPair() {
      const redis = base();
      const redisSub = base();
      redisSub.subscribe = async () => 1;
      redisSub.on = (event, fn) => {
        if (event === 'message') handlers.add(fn);
        return redisSub;
      };
      return { redis, redisSub };
    },
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const queue = [];
  const waiters = [];
  ws.addEventListener('message', async (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const i = waiters.findIndex((p) => !p.type || p.type === msg.type);
    if (i >= 0) {
      const [p] = waiters.splice(i, 1);
      clearTimeout(p.t);
      p.res(msg);
    } else {
      queue.push(msg);
    }
  });
  return {
    ws,
    next(type, ms = 5000) {
      const i = queue.findIndex((m) => !type || m.type === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const t = setTimeout(() => {
          const j = waiters.findIndex((p) => p.res === res);
          if (j >= 0) waiters.splice(j, 1);
          rej(new Error(`timeout waiting for message type=${type}`));
        }, ms);
        waiters.push({ type, res, t });
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        return;
      }
    },
  };
}

const baseUrl = (app) => `ws://127.0.0.1:${app.server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tallyFor = (idem, juror = SAMPLE_TALLY.juror) => ({ ...SAMPLE_TALLY, idem, juror });

describe.skipIf(!(await hasRedis()))('WS /ws/juror', () => {
  let app;
  const clients = [];

  beforeAll(async () => {
    const admin = new Redis(urlWithDb(15));
    await admin.flushdb();
    await admin.quit();
    app = await buildApp({
      config: { ...TEST_CONFIG, redisUrl: urlWithDb(15) },
      logger: false,
    });
    await waitUntilReady(app.redis);
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await app?.close().catch(() => null);
  });

  it('hello + valid tally → ACK with registered response', async () => {
    const c = await connect(`${baseUrl(app)}/ws/juror?juror=${SAMPLE_TALLY.juror}`);
    clients.push(c);
    expect(await c.next('hello')).toMatchObject({ instance: 'test-1' });
    c.ws.send(JSON.stringify({ type: 'tally', tally: tallyFor('ws-juror-0001') }));
    const resp = await c.next('response');
    expect(resp.response).toMatchObject({ status: 'registered' });
    expect(resp.response.receipt).toBeTruthy();
  });

  it('resend with the same idem → duplicate (P1 idempotency)', async () => {
    const c = await connect(`${baseUrl(app)}/ws/juror?juror=${SAMPLE_TALLY.juror}`);
    clients.push(c);
    await c.next('hello');
    const tally = { ...tallyFor('ws-juror-dupe'), tally: 'E14-176-0043-03', table: 4202 };
    c.ws.send(JSON.stringify({ type: 'tally', tally }));
    const r1 = await c.next('response');
    c.ws.send(JSON.stringify({ type: 'tally', tally }));
    const r2 = await c.next('response');
    expect(r1.response.status).toBe('registered');
    expect(r2.response).toMatchObject({ status: 'duplicate', receipt: r1.response.receipt });
  });

  it('rejects invalid tally, foreign juror, bad json and unknown types', async () => {
    const c = await connect(`${baseUrl(app)}/ws/juror?juror=${SAMPLE_TALLY.juror}`);
    clients.push(c);
    await c.next('hello');
    c.ws.send(
      JSON.stringify({ type: 'tally', tally: { ...tallyFor('ws-juror-bad'), votes: undefined } }),
    );
    expect(await c.next('error')).toMatchObject({ reason: 'invalid_tally' });
    c.ws.send(JSON.stringify({ type: 'tally', tally: tallyFor('ws-juror-other', 'JUR-IMPOSTOR') }));
    expect(await c.next('error')).toMatchObject({ reason: 'juror_mismatch' });
    c.ws.send('this is not json{');
    expect(await c.next('error')).toMatchObject({ reason: 'invalid_json' });
    c.ws.send(JSON.stringify({ type: 'magic' }));
    expect(await c.next('error')).toMatchObject({ reason: 'unknown_type' });
  });

  it('a huge message is rejected and the socket closed', async () => {
    const c = await connect(`${baseUrl(app)}/ws/juror?juror=${SAMPLE_TALLY.juror}`);
    clients.push(c);
    await c.next('hello');
    const closed = new Promise((res) => c.ws.addEventListener('close', res, { once: true }));
    c.ws.send(`{"type":"tally","padding":"${'x'.repeat(70 * 1024)}"}`);
    expect(await c.next('error')).toMatchObject({ reason: 'message_too_large' });
    await closed;
  });
});

describe('WS /ws/auditor', () => {
  const cluster = createFakeCluster();
  const pair1 = cluster.newPair();
  const pair2 = cluster.newPair();
  let app1;
  let app2;
  const clients = [];
  let n = 0;
  const uniqueTally = (base) => `F3-${base}-${++n}`;

  afterAll(async () => {
    for (const c of clients) c.close();
    await sleep(50);
    await app1?.close().catch(() => null);
    await app2?.close().catch(() => null);
  });

  it('without ?auditor= it is rejected with 4001', async () => {
    app1 = await buildApp({
      config: { ...TEST_CONFIG, instanceId: 'test-1' },
      ...pair1,
      logger: false,
    });
    await app1.listen({ port: 0, host: '127.0.0.1' });
    app2 = await buildApp({
      config: { ...TEST_CONFIG, instanceId: 'test-2' },
      ...pair2,
      logger: false,
    });
    await app2.listen({ port: 0, host: '127.0.0.1' });

    const ws = new WebSocket(`${baseUrl(app1)}/ws/auditor`);
    const error = await new Promise((res, rej) => {
      ws.addEventListener('message', async (ev) => {
        const t = typeof ev.data === 'string' ? ev.data : await ev.data.text();
        res(JSON.parse(t));
      });
      ws.addEventListener('error', rej);
    });
    const code = await new Promise((res) => ws.addEventListener('close', (ev) => res(ev.code)));
    expect(error).toMatchObject({ type: 'error', reason: 'missing_auditor' });
    expect(code).toBe(4001);
  });

  it('hello carries queue and present; take assigns the highest priority', async () => {
    const tally = uniqueTally('TAKE');
    await enqueueTally(tally, 5000, pair1.redis);
    const c = await connect(`${baseUrl(app1)}/ws/auditor?auditor=AUD-T1`);
    clients.push(c);
    const hello = await c.next('hello');
    expect(hello.instance).toBe('test-1');
    expect(hello.queue.map((x) => x.tally)).toContain(tally);
    expect(hello.present.map((p) => p.auditor)).toContain('AUD-T1');
    c.ws.send(JSON.stringify({ type: 'take' }));
    const kase = await c.next('case');
    expect(kase.case).toMatchObject({ tally });
    c.ws.send(JSON.stringify({ type: 'release', tally: kase.case.tally, token: kase.case.token }));
    expect(await c.next('released')).toMatchObject({ tally, ok: true });
  });

  it('two auditors take different tallies; a foreign token does not release', async () => {
    const high = uniqueTally('HIGH');
    const medium = uniqueTally('MEDIUM');
    await enqueueTally(high, 6001, pair1.redis);
    await enqueueTally(medium, 6000, pair1.redis);
    const a = await connect(`${baseUrl(app1)}/ws/auditor?auditor=AUD-T2`);
    const b = await connect(`${baseUrl(app2)}/ws/auditor?auditor=AUD-T3`);
    clients.push(a, b);
    await a.next('hello');
    await b.next('hello');
    a.ws.send(JSON.stringify({ type: 'take' }));
    b.ws.send(JSON.stringify({ type: 'take' }));
    const ca = await a.next('case');
    const cb = await b.next('case');
    expect(ca.case.tally).toBe(high);
    expect(cb.case.tally).toBe(medium);
    a.ws.send(JSON.stringify({ type: 'release', tally: cb.case.tally, token: 'fake' }));
    expect(await a.next('released')).toMatchObject({ ok: false });
    a.ws.send(JSON.stringify({ type: 'release', tally: ca.case.tally, token: ca.case.token }));
    b.ws.send(JSON.stringify({ type: 'release', tally: cb.case.tally, token: cb.case.token }));
    expect(await a.next('released')).toMatchObject({ ok: true });
    expect(await b.next('released')).toMatchObject({ ok: true });
  });

  it('already_has_case, heartbeat_ok and queue/present snapshots', async () => {
    const tally = uniqueTally('ALREADY');
    await enqueueTally(tally, 7000, pair1.redis);
    const c = await connect(`${baseUrl(app1)}/ws/auditor?auditor=AUD-T4`);
    clients.push(c);
    await c.next('hello');
    c.ws.send(JSON.stringify({ type: 'take' }));
    const kase = await c.next('case');
    expect(kase.case.tally).toBe(tally);
    c.ws.send(JSON.stringify({ type: 'take' }));
    expect(await c.next('error')).toMatchObject({ reason: 'already_has_case', tally });
    c.ws.send(JSON.stringify({ type: 'heartbeat', tally }));
    expect(await c.next('heartbeat_ok')).toBeTruthy();
    c.ws.send(JSON.stringify({ type: 'queue' }));
    expect((await c.next('queue')).queue.map((x) => x.tally)).toContain(tally);
    c.ws.send(JSON.stringify({ type: 'present' }));
    expect((await c.next('present')).present.map((p) => p.auditor)).toContain('AUD-T4');
    c.ws.send(JSON.stringify({ type: 'release', tally, token: kase.case.token }));
    expect(await c.next('released')).toMatchObject({ ok: true });
  });

  it('complete resolves and removes the tally from the queue', async () => {
    const tally = uniqueTally('COMP');
    await enqueueTally(tally, 8000, pair1.redis);
    const before = await queueSize(pair1.redis);
    const c = await connect(`${baseUrl(app1)}/ws/auditor?auditor=AUD-T5`);
    clients.push(c);
    await c.next('hello');
    c.ws.send(JSON.stringify({ type: 'take' }));
    const kase = await c.next('case');
    expect(kase.case.tally).toBe(tally);
    c.ws.send(JSON.stringify({ type: 'complete', tally, token: kase.case.token }));
    expect(await c.next('completed')).toMatchObject({ tally, ok: true });
    expect(await queueSize(pair1.redis)).toBe(before - 1);
    expect((await viewQueue()).map((x) => x.tally)).not.toContain(tally);
  });

  it('what is taken on instance 1 is broadcast to the console on instance 2', async () => {
    const tally = uniqueTally('BC');
    await enqueueTally(tally, 9000, pair1.redis);
    const b = await connect(`${baseUrl(app2)}/ws/auditor?auditor=AUD-T6`);
    clients.push(b);
    await b.next('hello');
    const a = await connect(`${baseUrl(app1)}/ws/auditor?auditor=AUD-T7`);
    clients.push(a);
    await a.next('hello');
    a.ws.send(JSON.stringify({ type: 'take' }));
    const kase = await a.next('case');
    expect(kase.case.tally).toBe(tally);
    const notice = await b.next('queue', 8000);
    expect(notice.event).toMatchObject({ type: 'assigned', tally });
    expect(notice.queue.find((x) => x.tally === tally)).toMatchObject({ assigned_to: 'AUD-T7' });
    a.ws.send(JSON.stringify({ type: 'release', tally, token: kase.case.token }));
    expect(await a.next('released')).toMatchObject({ ok: true });
  });
});

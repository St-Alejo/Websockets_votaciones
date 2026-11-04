import { Redis } from 'ioredis';
import { generateCatalog, prng, seedCatalog } from '../src/domain/catalog.js';
import { register } from '../src/redis/tallies.js';
import { defineCommands } from '../src/redis/scripts.js';
import * as K from '../src/contracts/keys.js';

const MODE = process.env.MODE ?? 'direct';
const APP_URL = process.env.URL ?? 'http://localhost:8080';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const SEED = Number(process.env.SEED ?? 2026);
const SPEED = Number(process.env.SPEED ?? 0);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);
const CANDIDATES = Number(process.env.CANDIDATES ?? 5);
const P_DOUBTFUL = 0.075;
const P_RESEND = 0.08;
const P_NEW_IDEM = 0.01;
const CORRECTIONS = 180;
const ELECTION_DAY_MS = 2 * 60 * 60 * 1000;

const random = prng(SEED + 1);
const between = (min, max) => min + Math.floor(random() * (max - min + 1));
const idem = () =>
  Math.floor(random() * 2 ** 52)
    .toString(16)
    .padStart(14, '0');

function generateVotes(balanced) {
  const votes = {};
  for (let c = 1; c <= CANDIDATES; c++) votes[`C${c}`] = between(20, 180);
  votes.BLANK = between(0, 25);
  votes.NULL = between(0, 12);
  votes.UNMARKED = between(0, 6);
  const sum = Object.values(votes).reduce((a, b) => a + b, 0);
  return { votes, voters: balanced ? sum : sum + between(1, 9) };
}

function closingTime() {
  const r = random();
  if (r < 0.15) return between(10 * 60e3, 15 * 60e3);
  if (r < 0.22) return between(25 * 60e3, 28 * 60e3);
  if (r < 0.55) return between(0, 40 * 60e3);
  return between(40 * 60e3, ELECTION_DAY_MS);
}

function electionDayPlan(cat) {
  const submissions = [];
  const latest = new Map();
  for (const [table, { station, municipality }] of cat.table) {
    const { votes, voters } = generateVotes(random() >= P_DOUBTFUL);
    const a = {
      tally: `E14-${station}-${table}-03`,
      table,
      station,
      municipality,
      version: 1,
      juror: `JUR-${table}`,
      closed_at: 1793577600,
      votes,
      voters,
      photo_hash: idem(),
      idem: idem(),
    };
    const t = closingTime();
    submissions.push({ t, tally: a, type: 'new' });
    latest.set(a.tally, { a, t });
    if (random() < P_RESEND)
      submissions.push({ t: t + between(5e3, 180e3), tally: a, type: 'resend' });
    if (random() < P_NEW_IDEM) {
      submissions.push({
        t: t + between(60e3, 600e3),
        tally: { ...a, idem: idem() },
        type: 'new_idem',
      });
    }
  }
  const tallies = [...latest.values()];
  for (let i = 0; i < CORRECTIONS; i++) {
    const { a, t } = tallies[between(0, tallies.length - 1)];
    const previous = latest.get(a.tally).a;
    const corr = {
      ...previous,
      ...generateVotes(true),
      version: previous.version + 1,
      idem: idem(),
    };
    const outOfOrder = random() < 0.3;
    submissions.push({
      t: outOfOrder ? Math.max(0, t - between(1e3, 30e3)) : t + between(5 * 60e3, 60 * 60e3),
      tally: corr,
      type: 'correction',
    });
    latest.set(a.tally, { a: corr, t });
  }
  submissions.sort((x, y) => x.t - y.t);
  return submissions;
}

function expected(submissions) {
  const best = new Map();
  for (const { tally: a } of submissions) {
    const sum = Object.values(a.votes).reduce((x, y) => x + y, 0);
    if (sum !== a.voters) continue;
    const prev = best.get(a.tally);
    if (!prev || a.version > prev.version) best.set(a.tally, a);
  }
  const dept = { reported: best.size, voters: 0 };
  for (const a of best.values()) {
    dept.voters += a.voters;
    for (const [k, v] of Object.entries(a.votes)) dept[k] = (dept[k] ?? 0) + v;
  }
  return dept;
}

async function run(submissions, send) {
  const statuses = {};
  const instances = {};
  let i = 0;
  const t0 = Date.now();
  const start = performance.now();
  async function worker() {
    while (i < submissions.length) {
      const e = submissions[i++];
      if (SPEED > 0) {
        const wait = e.t / SPEED - (Date.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      const { status, instance } = await send(e.tally);
      statuses[status] = (statuses[status] ?? 0) + 1;
      if (instance) instances[instance] = (instances[instance] ?? 0) + 1;
      if (i % 1000 === 0) process.stdout.write(`  ${i}/${submissions.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { statuses, instances, ms: performance.now() - start };
}

function sendDirect(redis) {
  return async (tally) => ({ status: (await register(redis, tally, { instance: 'sim' })).status });
}

function sendHttp(tally) {
  return fetch(`${APP_URL}/tallies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tally),
  })
    .then(async (res) => ({
      status:
        res.status === 429
          ? 'http_429'
          : res.status === 503
            ? 'http_503'
            : (await res.json()).status,
      instance: res.headers.get('x-instance-id'),
    }))
    .catch(() => ({ status: 'network_error' }));
}

const CATEGORIES = [
  ['tally:*:versions', /^tally:.*:versions$/],
  ['tally:*', /^tally:/],
  ['idem:*', /^idem:/],
  ['total:table:*', /^total:table:/],
  ['total:station:*', /^total:station:/],
  ['total:mun:*', /^total:mun:/],
  ['total:dept', /^total:dept$/],
  ['rank:*', /^rank:/],
  ['cat:*', /^cat:/],
  ['stream:tallies', /^stream:tallies$/],
  ['queue:verification', /^queue:verification$/],
  ['rl:*', /^rl:/],
];

async function measureMemory(redis) {
  const rows = new Map(CATEGORIES.map(([n]) => [n, { keys: 0, bytes: 0 }]));
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    const p = redis.pipeline();
    for (const k of keys) p.call('MEMORY', 'USAGE', k, 'SAMPLES', '0');
    const usages = await p.exec();
    keys.forEach((k, j) => {
      const cat = CATEGORIES.find(([, re]) => re.test(k))?.[0] ?? 'other';
      if (!rows.has(cat)) rows.set(cat, { keys: 0, bytes: 0 });
      const f = rows.get(cat);
      f.keys++;
      f.bytes += Number(usages[j][1] ?? 0);
    });
  } while (cursor !== '0');
  const info = await redis.info('memory');
  const used = Number(/used_memory:(\d+)/.exec(info)[1]);
  return { rows, used };
}

const kb = (b) => (b / 1024).toFixed(1);

const cat = generateCatalog(SEED);
const submissions = electionDayPlan(cat);
const count = submissions.reduce((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});
console.log(
  `[simulate-tallies] ${submissions.length} submissions (${JSON.stringify(count)}), mode ${MODE}`,
);

const redis = defineCommands(new Redis(REDIS_URL));
try {
  if (process.env.CLEAN === '1') {
    await redis.flushdb();
    console.log(`  database flushed (${REDIS_URL})`);
  }
  await seedCatalog(redis, SEED);

  const r = await run(submissions, MODE === 'http' ? sendHttp : sendDirect(redis));
  console.log(`\nStatuses: ${JSON.stringify(r.statuses)}`);
  if (MODE === 'http') console.log(`Per instance: ${JSON.stringify(r.instances)}`);
  console.log(
    `Duration: ${(r.ms / 1000).toFixed(1)} s (${Math.round(submissions.length / (r.ms / 1000))} submissions/s)`,
  );

  const exp = expected(submissions);
  const actual = await redis.hgetall(K.total('dept'));
  const fields = Object.keys(exp);
  const diffs = fields.filter((k) => Number(actual[k] ?? 0) !== exp[k]);
  console.log(
    diffs.length === 0
      ? `Department totals CONSISTENT with expected (${exp.reported} tables reported).`
      : `DIFFERENCES in ${diffs.join(', ')}: expected ${JSON.stringify(exp)} actual ${JSON.stringify(actual)}`,
  );
  console.log(
    `Verification queue: ${await redis.zcard(K.verificationQueue)} doubtful tallies pending.`,
  );

  if (process.env.MEASURE === '1') {
    const { rows, used } = await measureMemory(redis);
    console.log('\n| Structure | Keys | Memory (KB) | Bytes/key |');
    console.log('| --- | ---: | ---: | ---: |');
    let total = 0;
    for (const [n, f] of rows) {
      if (!f.keys) continue;
      total += f.bytes;
      console.log(`| \`${n}\` | ${f.keys} | ${kb(f.bytes)} | ${Math.round(f.bytes / f.keys)} |`);
    }
    console.log(`| **Total (MEMORY USAGE)** | | **${kb(total)}** | |`);
    console.log(`\nServer used_memory: ${(used / 1024 / 1024).toFixed(2)} MB`);
    console.log(`stream:tallies: ${await redis.xlen(K.tallyStream)} entries`);
  }
} finally {
  await redis.quit();
}

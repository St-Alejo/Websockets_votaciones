import { randomBytes } from 'node:crypto';
import { IncomingTally } from '../src/contracts/schemas.js';

const BASE_URL = process.env.URL ?? 'http://localhost:3000';
const N = Number(process.env.N ?? 50);
const INTERVAL = Number(process.env.INTERVAL_MS ?? 100);
const P_RESEND = 0.1;
const P_CORRECTION = 0.03;
const P_DOUBTFUL = 0.07;

const random = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const idem = () => randomBytes(8).toString('hex');

function randomVotes() {
  return {
    C1: random(50, 300),
    C2: random(50, 300),
    C3: random(50, 300),
    BLANK: random(0, 30),
    NULL: random(0, 15),
    UNMARKED: random(0, 8),
  };
}

function newTally() {
  const station = random(1, 1842);
  const table = random(1, 6400);
  const votes = randomVotes();
  let voters = Object.values(votes).reduce((a, b) => a + b, 0);
  if (Math.random() < P_DOUBTFUL) voters += random(1, 5);
  return IncomingTally.parse({
    tally: `E14-${String(station).padStart(3, '0')}-${String(table).padStart(4, '0')}-03`,
    table,
    station,
    municipality: random(1, 20),
    version: 1,
    juror: `JUR-${random(10000, 99999)}`,
    closed_at: Math.floor(Date.now() / 1000),
    votes,
    voters,
    photo_hash: randomBytes(16).toString('hex'),
    idem: idem(),
  });
}

function correct(tally) {
  const votes = randomVotes();
  const voters = Object.values(votes).reduce((a, b) => a + b, 0);
  return { ...tally, version: tally.version + 1, votes, voters, idem: idem() };
}

const statuses = {};
const instances = {};
const sent = [];

async function send(tally, label) {
  try {
    const res = await fetch(`${BASE_URL}/tallies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tally),
    });
    const body = await res.json();
    const inst = res.headers.get('x-instance-id') ?? '?';
    statuses[body.status] = (statuses[body.status] ?? 0) + 1;
    instances[inst] = (instances[inst] ?? 0) + 1;
    console.log(
      `${label.padEnd(10)} ${tally.tally} v${tally.version} → ${res.status} ${body.status} [${inst}]`,
    );
  } catch (e) {
    statuses.network_error = (statuses.network_error ?? 0) + 1;
    console.log(`${label.padEnd(10)} ${tally.tally} → network error: ${e.message}`);
  }
}

console.log(`[fake-juror] ${N} tallies against ${BASE_URL}`);
for (let i = 0; i < N; i++) {
  const r = Math.random();
  if (sent.length && r < P_RESEND) {
    await send(sent[random(0, sent.length - 1)], 'resend');
  } else if (sent.length && r < P_RESEND + P_CORRECTION) {
    const j = random(0, sent.length - 1);
    sent[j] = correct(sent[j]);
    await send(sent[j], 'correction');
  } else {
    const tally = newTally();
    sent.push(tally);
    await send(tally, 'new');
  }
  await pause(INTERVAL);
}

console.log('\nStatuses:', statuses);
console.log('Responses per instance:', instances);

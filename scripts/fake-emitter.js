import { Redis } from 'ioredis';
import { CHANNELS } from '../src/contracts/channels.js';
import { NewTallyEvent } from '../src/contracts/schemas.js';
import { tallyStream } from '../src/contracts/keys.js';
import { streamFields } from '../src/contracts/stream.js';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const interval = Number(process.env.INTERVAL_MS ?? 1000);
const MAXLEN = 10_000;

const redis = new Redis(url);
const random = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const versions = new Map();
let emitted = 0;

function nextEvent() {
  if (versions.size > 0 && Math.random() < 0.03) {
    const tallies = [...versions.keys()];
    const tally = tallies[random(0, tallies.length - 1)];
    const version = versions.get(tally) + 1;
    versions.set(tally, version);
    const [, station] = tally.split('-');
    return { tally, mun: random(1, 20), station: Number(station), version, type: 'correction' };
  }
  const station = random(1, 1842);
  const table = random(1, 6400);
  const tally = `E14-${String(station).padStart(3, '0')}-${String(table).padStart(4, '0')}-03`;
  versions.set(tally, 1);
  return { tally, mun: random(1, 20), station, version: 1, type: 'new' };
}

async function emit() {
  const event = nextEvent();
  const id = await redis.xadd(tallyStream, 'MAXLEN', '~', MAXLEN, '*', ...streamFields(event));
  const full = NewTallyEvent.parse({ ...event, stream_id: id });
  await redis.publish(CHANNELS.NEW_TALLY, JSON.stringify(full));
  emitted++;
  console.log(`[fake-emitter] #${emitted} ${full.type} ${full.tally} v${full.version} → ${id}`);
}

console.log(`[fake-emitter] Redis ${url}, every ${interval} ms. Ctrl+C to exit.`);
const timer = setInterval(() => emit().catch((e) => console.error(e.message)), interval);

process.on('SIGINT', async () => {
  clearInterval(timer);
  await redis.quit();
  console.log(`\n[fake-emitter] ${emitted} events emitted.`);
  process.exit(0);
});

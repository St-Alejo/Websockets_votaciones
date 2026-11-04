import { parseTopic } from '../contracts/channels.js';
import * as redisHistory from '../redis/history.js';

export function readCursor(req = {}) {
  const headers = req.headers ?? {};
  const raw = headers['last-event-id'] ?? headers['Last-Event-ID'] ?? req.query?.last_id ?? null;
  if (raw == null) return null;
  const text = String(raw).trim();
  return text === '' ? null : text;
}

export function affectsTopic(event, topic) {
  const { level, id } = parseTopic(topic);
  if (level === 'dept') return true;
  if (level === 'mun') return String(event.mun) === String(id);
  if (level === 'station') return String(event.station) === String(id);
  if (level === 'table') {
    if (event.table != null) return String(event.table) === String(id);
    const parts = String(event.tally ?? '').split('-');
    return parts[2] != null && String(Number(parts[2])) === String(Number(id));
  }
  return false;
}

export async function decideResume(options = {}) {
  const cursor = options.cursor ?? null;
  const topic = options.topic;
  const limit = options.maxDeltas ?? 500;
  const read = options.history?.readSince ?? redisHistory.readSince;
  const takeSnapshot =
    options.snapshot ??
    (async (levels) => {
      const domain = await import('../domain/index.js');
      return domain.snapshot(levels);
    });

  if (!cursor) {
    return {
      mode: 'snapshot',
      reason: 'no_cursor',
      snapshot: await takeSnapshot([topic]),
      events: [],
    };
  }

  let hist;
  try {
    hist = await read(cursor, limit);
  } catch {
    return {
      mode: 'snapshot',
      reason: 'history_unavailable',
      snapshot: await takeSnapshot([topic]),
      events: [],
    };
  }

  if (!hist || hist.trimmed || hist.hasMore || (hist.events?.length ?? 0) >= limit) {
    let reason = 'gap_too_large';
    if (!hist) reason = 'history_unavailable';
    else if (hist.trimmed) reason = 'history_trimmed';
    return {
      mode: 'snapshot',
      reason,
      snapshot: await takeSnapshot([topic]),
      events: [],
    };
  }

  const events = (hist.events ?? []).filter((event) => affectsTopic(event, topic));
  return {
    mode: 'deltas',
    reason: 'up_to_date',
    events,
    stream_id: hist.stream_id ?? cursor,
  };
}

export function exponentialBackoff({
  attempt = 0,
  baseMs = 500,
  maxMs = 30_000,
  random = Math.random,
} = {}) {
  const n = Math.max(0, attempt);
  const rawMs = baseMs * 2 ** n;
  const ceilingMs = Math.min(maxMs, Number.isFinite(rawMs) ? rawMs : maxMs);
  const half = ceilingMs / 2;
  const waitMs = Math.min(ceilingMs, Math.floor(half + random() * half));
  return { attempt: n, ceilingMs, waitMs };
}

export function retryDirective(random = Math.random) {
  const { waitMs } = exponentialBackoff({
    attempt: 1,
    baseMs: 1000,
    maxMs: 15_000,
    random,
  });
  return Math.max(1000, waitMs);
}

export function createReconnectClient({
  connect,
  baseMs = 250,
  maxMs = 30_000,
  random = Math.random,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
} = {}) {
  let attempt = 0;
  let timer = null;
  let active = true;
  const waits = [];

  async function start() {
    if (!active) return;
    try {
      await connect();
      attempt = 0;
    } catch {
      if (!active) return;
      const plan = exponentialBackoff({ attempt, baseMs, maxMs, random });
      waits.push(plan.waitMs);
      attempt += 1;
      timer = schedule(() => {
        start();
      }, plan.waitMs);
    }
  }

  return {
    start,
    waits,
    cancel() {
      active = false;
      if (timer != null) cancel(timer);
      timer = null;
    },
    get attempt() {
      return attempt;
    },
  };
}

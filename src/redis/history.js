import { tallyStream } from '../contracts/keys.js';
import { eventFromEntry } from '../contracts/stream.js';
import { translateRedisError } from '../domain/errors.js';
import { getRedis } from './client.js';

const ID = /^\d+-\d+$/;

export function compareIds(a, b) {
  const [am, as] = a.split('-').map(BigInt);
  const [bm, bs] = b.split('-').map(BigInt);
  if (am !== bm) return am < bm ? -1 : 1;
  return as === bs ? 0 : as < bs ? -1 : 1;
}

export async function lastId(redis) {
  try {
    const [last] = await redis.xrevrange(tallyStream, '+', '-', 'COUNT', 1);
    return last ? last[0] : '0-0';
  } catch (err) {
    throw translateRedisError(err);
  }
}

function field(info, name) {
  const i = info.indexOf(name);
  return i === -1 ? null : info[i + 1];
}

export async function readSince(...args) {
  const withClient = args[0] && typeof args[0] === 'object' && typeof args[0].xrange === 'function';
  if (withClient) return readSinceStream(...args);
  const [cursor, max] = args;
  const limit = Number(max) > 0 ? Number(max) : 500;
  const redis = getRedis();
  if (redis?.status === 'ready') {
    const r = await readSinceStream(redis, cursor ?? '0-0', limit);
    return withAlias({ trimmed: false, ...r });
  }
  return readSinceMemory(cursor, limit);
}

function withAlias(r) {
  return { ...r, hasMore: Boolean(r.has_more) };
}

async function readSinceStream(redis, cursor, max) {
  const limit = Math.max(1, Math.min(Number(max) || 500, 5000));
  if (!ID.test(String(cursor ?? ''))) {
    return { events: [], stream_id: await lastId(redis), trimmed: true };
  }
  try {
    const [entries, info] = await Promise.all([
      redis.xrange(tallyStream, `(${cursor}`, '+', 'COUNT', limit + 1),
      redis.xinfo('STREAM', tallyStream).catch(() => null),
    ]);
    if (!info) return { events: [], stream_id: '0-0' };

    const first = field(info, 'first-entry')?.[0];
    const wasTrimmed = Number(field(info, 'entries-added')) > Number(field(info, 'length'));
    const deleted = field(info, 'max-deleted-entry-id') ?? '0-0';
    const trimmed =
      (wasTrimmed && first !== undefined && compareIds(cursor, first) < 0) ||
      (deleted !== '0-0' && compareIds(cursor, deleted) < 0);
    const hasMore = entries.length > limit;
    const events = entries.slice(0, limit).map(eventFromEntry);
    const stream_id = events.length
      ? events[events.length - 1].stream_id
      : field(info, 'last-generated-id');
    return {
      events,
      stream_id,
      ...(trimmed && { trimmed }),
      ...(hasMore && { has_more: true }),
    };
  } catch (err) {
    throw translateRedisError(err);
  }
}

const MAX_MEMORY = 10_000;
const memory = [];

export const compareStreamIds = (a, b) => compareIds(String(a ?? '0-0'), String(b ?? '0-0'));

export function recordInMemory(event) {
  memory.push({ ...event });
  if (memory.length > MAX_MEMORY) memory.splice(0, memory.length - MAX_MEMORY);
}

export function clearMemory() {
  memory.length = 0;
}

function readSinceMemory(streamId, limit) {
  const events = memory.slice().sort((a, b) => compareStreamIds(a.stream_id, b.stream_id));
  if (events.length === 0) {
    return {
      events: [],
      stream_id: streamId || '0-0',
      trimmed: Boolean(streamId),
      hasMore: false,
    };
  }
  if (streamId && compareStreamIds(streamId, events[0].stream_id) < 0) {
    return { events: [], stream_id: events.at(-1).stream_id, trimmed: true, hasMore: false };
  }
  const later = streamId
    ? events.filter((e) => compareStreamIds(e.stream_id, streamId) > 0)
    : events;
  const page = later.slice(0, limit);
  return {
    events: page,
    stream_id: page.length ? page.at(-1).stream_id : streamId || events.at(-1).stream_id,
    trimmed: false,
    hasMore: later.length > limit,
  };
}

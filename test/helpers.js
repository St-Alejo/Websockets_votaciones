import { buildApp } from '../src/server.js';

export function fakeRedis() {
  return {
    status: 'wait',
    ping: async () => 'PONG',
    quit: async () => 'OK',
    on() {
      return this;
    },
  };
}

export const TEST_CONFIG = Object.freeze({
  port: 0,
  host: '127.0.0.1',
  redisUrl: 'redis://localhost:6379',
  instanceId: 'test-1',
  logLevel: 'silent',
});

export function testApp(extra = {}) {
  return buildApp({
    config: TEST_CONFIG,
    redis: fakeRedis(),
    redisSub: fakeRedis(),
    logger: false,
    ...extra,
  });
}

export const SAMPLE_TALLY = Object.freeze({
  tally: 'E14-176-0042-03',
  table: 4201,
  station: 176,
  municipality: 11,
  version: 1,
  juror: 'JUR-88134',
  closed_at: 1793577600,
  votes: { C1: 184, C2: 97, C3: 311, BLANK: 22, NULL: 9, UNMARKED: 4 },
  voters: 627,
  photo_hash: '9f2c...',
  idem: '8f14e45fceea167a',
});

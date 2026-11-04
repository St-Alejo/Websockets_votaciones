import { ReplyError } from 'ioredis';

export class RedisUnavailableError extends Error {
  constructor(cause) {
    super(`Redis unavailable: ${cause?.message ?? cause}`);
    this.name = 'RedisUnavailableError';
    this.code = 'redis_unavailable';
    this.cause = cause;
  }
}

export class RateLimitError extends Error {
  constructor(juror, retryInMs) {
    super(`Rate limit exceeded for ${juror}`);
    this.name = 'RateLimitError';
    this.code = 'rate_limited';
    this.juror = juror;
    this.retryInS = Math.max(1, Math.ceil(retryInMs / 1000));
  }
}

const UNAVAILABILITY_REPLY = /^(LOADING|BUSY|OOM|READONLY|MASTERDOWN|CLUSTERDOWN|TRYAGAIN)/;

export function translateRedisError(err) {
  if (isDomainError(err)) return err;
  if (err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError) {
    return err;
  }
  if (err instanceof ReplyError && !UNAVAILABILITY_REPLY.test(err.message)) return err;
  return new RedisUnavailableError(err);
}

export function isDomainError(err) {
  return err?.code === 'redis_unavailable' || err?.code === 'rate_limited';
}

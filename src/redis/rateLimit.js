import { rateLimit } from '../contracts/keys.js';
import { RateLimitError, translateRedisError } from '../domain/errors.js';

export async function consume(redis, juror, { max, windowMs, now = Date.now() }) {
  const window = Math.floor(now / windowMs);
  let count, remainingMs;
  try {
    [count, remainingMs] = await redis.rateLimitLua(rateLimit(juror, window), windowMs);
  } catch (err) {
    throw translateRedisError(err);
  }
  if (count > max) throw new RateLimitError(juror, remainingMs > 0 ? remainingMs : windowMs);
  return { count, remainingMs };
}

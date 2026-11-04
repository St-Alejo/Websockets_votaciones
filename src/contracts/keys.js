export const LEVELS = Object.freeze(['dept', 'mun', 'station', 'table']);

function validateLevel(level, id) {
  if (!LEVELS.includes(level)) {
    throw new Error(`Invalid level "${level}". Use one of: ${LEVELS.join(', ')}`);
  }
  if (level !== 'dept' && (id === undefined || id === null || id === '')) {
    throw new Error(`Level "${level}" requires an id`);
  }
}

function suffix(level, id) {
  validateLevel(level, id);
  return level === 'dept' ? 'dept' : `${level}:${id}`;
}

export const tally = (id) => `tally:${id}`;

export const tallyVersions = (id) => `tally:${id}:versions`;

export const idem = (k) => `idem:${k}`;

export const TTL_IDEM_S = 24 * 60 * 60;

export const total = (level, id) => `total:${suffix(level, id)}`;

export const rank = (level, id) => `rank:${suffix(level, id)}`;

export const catalog = (level, id) => `cat:${suffix(level, id)}:tables`;

export const tallyStream = 'stream:tallies';

export const verificationQueue = 'queue:verification';

export const tallyLock = (id) => `lock:tally:${id}`;

export const presence = (auditor) => `presence:${auditor}`;

export const rateLimit = (juror, window) => `rl:${juror}:${window}`;

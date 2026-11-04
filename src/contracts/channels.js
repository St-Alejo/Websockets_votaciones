export const CHANNELS = Object.freeze({
  NEW_TALLY: 'tally:new',
  VERIFICATION: 'verification',
  PRESENCE: 'presence',
});

export function topic(level, id) {
  return level === 'dept' ? 'dept' : `${level}:${id}`;
}

export function parseTopic(text) {
  if (text === 'dept') return { level: 'dept', id: null };
  const m = /^(mun|station|table):([A-Za-z0-9-]+)$/.exec(String(text ?? ''));
  if (!m) throw new Error(`Invalid topic "${text}"`);
  return { level: m[1], id: m[2] };
}

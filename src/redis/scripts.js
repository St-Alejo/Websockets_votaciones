import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`./scripts/${name}.lua`, import.meta.url), 'utf8');

export const SCRIPTS = Object.freeze({
  registerTallyLua: { file: 'register', numberOfKeys: 12 },
  snapshotLua: { file: 'snapshot' },
  rateLimitLua: { file: 'rate-limit', numberOfKeys: 1 },
});

const sources = Object.fromEntries(
  Object.entries(SCRIPTS).map(([name, s]) => [name, read(s.file)]),
);

export function defineCommands(redis) {
  for (const [name, s] of Object.entries(SCRIPTS)) {
    if (typeof redis[name] === 'function') continue;
    redis.defineCommand(name, { lua: sources[name], numberOfKeys: s.numberOfKeys });
  }
  return redis;
}

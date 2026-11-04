import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { SIGNATURES } from '../../src/contracts/interfaces.js';
import * as keys from '../../src/contracts/keys.js';
import { CHANNELS, parseTopic, topic } from '../../src/contracts/channels.js';
import { streamFields, eventFromEntry } from '../../src/contracts/stream.js';

const root = join(import.meta.dirname, '..', '..');

describe('interfaces: each facade exposes the functions with the agreed signature', () => {
  for (const [module, functions] of Object.entries(SIGNATURES)) {
    it(module, async () => {
      const m = await import(pathToFileURL(join(root, module)).href);
      for (const [name, arity] of Object.entries(functions)) {
        expect(typeof m[name], `${module} → ${name}`).toBe('function');
        expect(m[name].length, `${module} → ${name}: number of parameters`).toBe(arity);
      }
    });
  }
});

describe('keys', () => {
  it('builds the agreed names', () => {
    expect(keys.tally('E14-176-0042-03')).toBe('tally:E14-176-0042-03');
    expect(keys.tallyVersions('A')).toBe('tally:A:versions');
    expect(keys.idem('k')).toBe('idem:k');
    expect(keys.total('dept')).toBe('total:dept');
    expect(keys.total('mun', 11)).toBe('total:mun:11');
    expect(keys.total('station', 176)).toBe('total:station:176');
    expect(keys.total('table', 4201)).toBe('total:table:4201');
    expect(keys.rank('mun', 11)).toBe('rank:mun:11');
    expect(keys.catalog('station', 176)).toBe('cat:station:176:tables');
    expect(keys.tallyStream).toBe('stream:tallies');
    expect(keys.verificationQueue).toBe('queue:verification');
    expect(keys.tallyLock('A')).toBe('lock:tally:A');
    expect(keys.presence('AUD-1')).toBe('presence:AUD-1');
    expect(keys.rateLimit('JUR-1', 123)).toBe('rl:JUR-1:123');
  });

  it('rejects invalid levels or missing id', () => {
    expect(() => keys.total('country', 1)).toThrow();
    expect(() => keys.total('mun')).toThrow();
  });
});

describe('channels and topics', () => {
  it('channel names', () => {
    expect(CHANNELS).toEqual({
      NEW_TALLY: 'tally:new',
      VERIFICATION: 'verification',
      PRESENCE: 'presence',
    });
  });

  it('topic round trip', () => {
    expect(topic('mun', 11)).toBe('mun:11');
    expect(parseTopic('mun:11')).toEqual({ level: 'mun', id: '11' });
    expect(parseTopic('dept')).toEqual({ level: 'dept', id: null });
    expect(() => parseTopic('country:1')).toThrow();
  });

  it('stream entry format round trip', () => {
    const e = {
      stream_id: '5-0',
      tally: 'E14-1-2-03',
      mun: 1,
      station: 1,
      version: 2,
      type: 'correction',
    };
    expect(eventFromEntry(['5-0', streamFields(e)])).toEqual(e);
  });
});

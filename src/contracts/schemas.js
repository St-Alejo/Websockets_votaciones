import { z } from 'zod';

const integer = z.number().int().nonnegative();

export const Votes = z
  .record(z.string().regex(/^(C\d+|BLANK|NULL|UNMARKED)$/, 'Invalid vote key'), integer)
  .refine((v) => 'BLANK' in v && 'NULL' in v && 'UNMARKED' in v, {
    message: 'Missing BLANK, NULL or UNMARKED',
  })
  .refine((v) => Object.keys(v).some((k) => /^C\d+$/.test(k)), {
    message: 'There must be at least one candidate C1..Cn',
  });

export const IncomingTally = z.object({
  tally: z.string().regex(/^E14-\d+-\d+-\d+$/, 'Expected format E14-station-table-corporation'),
  table: z.number().int().positive(),
  station: z.number().int().positive(),
  municipality: z.number().int().positive(),
  version: z.number().int().positive(),
  juror: z.string().min(1),
  closed_at: z.number().int().positive(),
  votes: Votes,
  voters: integer,
  photo_hash: z.string().min(1),
  idem: z.string().min(8).max(128),
});

export function balances(tally) {
  const sum = Object.values(tally.votes).reduce((a, b) => a + b, 0);
  return sum === tally.voters;
}

export const REGISTER_STATUSES = Object.freeze([
  'registered',
  'duplicate',
  'stale_version',
  'conflict',
  'doubtful',
  'rejected',
]);

export const RegisterResponse = z.object({
  status: z.enum(REGISTER_STATUSES),
  tally: z.string(),
  version: z.number().int(),
  receipt: z.string().nullable(),
  current_version: z.number().int().optional(),
  reason: z.string().optional(),
});

export const NewTallyEvent = z.object({
  stream_id: z.string().regex(/^\d+-\d+$/),
  tally: z.string(),
  mun: z.number().int(),
  station: z.number().int(),
  version: z.number().int().positive(),
  type: z.enum(['new', 'correction']),
});

export const VerificationEvent = z.object({
  type: z.enum(['queued', 'assigned', 'released', 'resolved']),
  tally: z.string(),
  auditor: z.string().optional(),
});

export const PresenceEvent = z.object({
  auditor: z.string(),
  status: z.enum(['online', 'offline']),
  instance: z.string(),
  current_tally: z.string().nullable().optional(),
  since: z.number().int().optional(),
});

export const Totals = z.object({
  level: z.enum(['dept', 'mun', 'station', 'table']),
  id: z.string().nullable(),
  votes: z.record(z.string(), integer),
  voters: integer,
  tables_reported: integer,
  tables_total: integer,
  percent_reported: z.number().min(0).max(100),
});

export const RankingRow = z.object({ candidate: z.string(), votes: integer });

export const Snapshot = z.object({
  levels: z.record(z.string(), Totals),
  stream_id: z.string().regex(/^\d+-\d+$/),
});

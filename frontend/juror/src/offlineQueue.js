export const STATUSES = Object.freeze({
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  FAILED: 'FAILED',
});

const CONFIRMS = new Set(['registered', 'duplicate', 'stale_version', 'conflict', 'doubtful']);

export function createOfflineQueue({
  storage,
  generateId = () => (crypto?.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random()}`),
  now = () => Date.now(),
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  baseMs = 1000,
  maxMs = 30_000,
  maxAttempts = 20,
} = {}) {
  if (!storage) throw new Error('storage required');
  const listeners = new Set();
  let processing = false;
  const notify = () => {
    for (const fn of [...listeners]) fn();
  };

  async function save(tally, idem = null) {
    const submission = {
      id: generateId(),
      idem: idem ?? generateId(),
      tally,
      status: STATUSES.PENDING,
      attempts: 0,
      lastError: null,
      response: null,
      createdAt: now(),
      updatedAt: now(),
    };
    await storage.put(submission);
    notify();
    return submission;
  }

  async function list() {
    const all = await storage.getAll();
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function get(id) {
    return storage.get(id);
  }

  async function mark(id, patch) {
    const previous = await storage.get(id);
    if (!previous) return null;
    const submission = { ...previous, ...patch, updatedAt: now() };
    await storage.put(submission);
    notify();
    return submission;
  }

  function delayFor(attempts) {
    return Math.min(maxMs, baseMs * 2 ** attempts) + Math.random() * 500;
  }

  async function process({ canSend, send }) {
    if (processing) return;
    processing = true;
    try {
      for (;;) {
        const pending = (await list()).filter((e) => e.status === STATUSES.PENDING);
        if (pending.length === 0) return;
        if (!canSend()) return;
        const submission = pending[0];
        await mark(submission.id, { status: STATUSES.SENDING });
        let response;
        try {
          response = await send(submission);
        } catch (err) {
          const attempts = submission.attempts + 1;
          if (attempts >= maxAttempts) {
            await mark(submission.id, {
              status: STATUSES.FAILED,
              attempts,
              lastError: err?.message ?? 'network failure',
            });
            return;
          }
          await mark(submission.id, {
            status: STATUSES.PENDING,
            attempts,
            lastError: err?.message ?? 'network failure',
          });
          const ms = delayFor(attempts);
          processing = false;
          await wait(ms);
          return process({ canSend, send });
        }
        if (response && CONFIRMS.has(response.status)) {
          await mark(submission.id, { status: STATUSES.ACKNOWLEDGED, response, lastError: null });
        } else {
          await mark(submission.id, {
            status: STATUSES.FAILED,
            response: response ?? null,
            lastError: response?.reason ?? `status ${response?.status ?? 'unknown'}`,
          });
          return;
        }
      }
    } finally {
      processing = false;
    }
  }

  async function retry(id) {
    return mark(id, { status: STATUSES.PENDING, lastError: null });
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { save, list, get, process, retry, subscribe, delayFor, STATUSES };
}

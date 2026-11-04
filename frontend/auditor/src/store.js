export function createStore() {
  const state = {
    auditor: null,
    instance: null,
    connected: false,
    queue: [],
    present: [],
    known: new Map(),
    myCase: null,
    resolvedThisSession: 0,
    log: [],
  };
  const listeners = new Set();
  return {
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update(patch) {
      Object.assign(state, patch);
      for (const fn of listeners) fn(state);
    },
    markSeen(list) {
      const seen = new Set(list.map((p) => p.auditor));
      for (const p of list) state.known.set(p.auditor, { record: p, online: true });
      for (const [auditor, info] of state.known) {
        if (!seen.has(auditor)) info.online = false;
      }
      for (const fn of listeners) fn(state);
    },
    markPresenceEvent(event) {
      if (!event || !event.auditor) return;
      state.known.set(event.auditor, {
        record: { ...event, current_tally: event.current_tally ?? null },
        online: event.status !== 'offline',
      });
      for (const fn of listeners) fn(state);
    },
    addLog(text, cssClass = '') {
      state.log.unshift({ time: new Date(), text, cssClass });
      state.log = state.log.slice(0, 80);
      for (const fn of listeners) fn(state);
    },
  };
}

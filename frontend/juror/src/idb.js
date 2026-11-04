const DB = 'juror-offline';
const STORE = 'submissions';

function supportsIdb() {
  return typeof indexedDB !== 'undefined';
}

function open() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export function createIdbStorage() {
  if (!supportsIdb()) return { ...createMemoryStorage(), persistent: false };
  let db = null;
  async function connection() {
    if (!db) db = await open();
    return db;
  }
  function tx(mode, fn) {
    return connection().then(
      (d) =>
        new Promise((res, rej) => {
          const t = d.transaction(STORE, mode);
          const st = t.objectStore(STORE);
          const r = fn(st);
          t.oncomplete = () => res(r?.result ?? r);
          t.onerror = () => rej(t.error);
        }),
    );
  }
  return {
    persistent: true,
    put: (submission) => tx('readwrite', (st) => st.put(submission)),
    get: (id) =>
      tx('readonly', (st) => st.get(id)).then((r) => r ?? null),
    getAll: () => tx('readonly', (st) => st.getAll()).then((r) => r ?? []),
  };
}

export function createMemoryStorage() {
  const map = new Map();
  return {
    persistent: false,
    async put(e) {
      map.set(e.id, { ...e });
    },
    async get(id) {
      return map.get(id) ?? null;
    },
    async getAll() {
      return [...map.values()];
    },
  };
}

// Adaptador IndexedDB para la cola offline. Si el navegador no soporta
// IndexedDB se usa memoria (sesión): la app avisa que recargar pierde envíos.
const DB = 'jurado-offline';
const STORE = 'envios';

function soportaIDB() {
  return typeof indexedDB !== 'undefined';
}

function abrir() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export function crearStorageIDB() {
  if (!soportaIDB()) return { ...crearStorageMemoria(), persistente: false };
  let db = null;
  async function con() {
    if (!db) db = await abrir();
    return db;
  }
  function tx(modo, fn) {
    return con().then(
      (d) =>
        new Promise((res, rej) => {
          const t = d.transaction(STORE, modo);
          const st = t.objectStore(STORE);
          const r = fn(st);
          t.oncomplete = () => res(r?.result ?? r);
          t.onerror = () => rej(t.error);
        }),
    );
  }
  return {
    persistente: true,
    put: (envio) => tx('readwrite', (st) => st.put(envio)),
    get: (id) =>
      tx('readonly', (st) => st.get(id)).then((r) => r ?? null),
    getAll: () => tx('readonly', (st) => st.getAll()).then((r) => r ?? []),
  };
}

export function crearStorageMemoria() {
  const mapa = new Map();
  return {
    persistente: false,
    async put(e) {
      mapa.set(e.id, { ...e });
    },
    async get(id) {
      return mapa.get(id) ?? null;
    },
    async getAll() {
      return [...mapa.values()];
    },
  };
}

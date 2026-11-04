# App de jurados (Persona 3, RT-6 offline-first)

Registro de actas que funciona sin conexión: **guarda primero en IndexedDB y
transmite al recuperar la red**. Vanilla ESM sin build.

## Correr

```bash
cd frontend/jurado
npx --yes serve . -l 5175
```

## Probar RT-6 a mano

1. Apaga la red (o cierra el backend), registra un acta → queda `PENDING`.
2. Recarga la página → el acta sigue en el historial (IndexedDB).
3. Enciende la red → se envía sola y pasa a `ACKNOWLEDGED` con el `recibo`.
4. Reenviar el mismo `idem` responde `duplicada`: sin actas duplicadas.

## Diseño (`src/`)

- `offlineQueue.js` — máquina de estados `PENDING → SENDING → ACKNOWLEDGED | FAILED`,
  `idem` generado una vez y reutilizado, backoff exponencial + jitter, stop-and-wait.
- `idb.js` — IndexedDB `jurado-offline.envios` (+ fallback en memoria avisado).
- `ws.js` — WS con reconexión; `enviarActa()` resuelve **solo con el ACK real**.
- `app.js` — formulario con regla contable (avisa `dudosa`, no bloquea), historial.

## Tests

```bash
npm test --prefix frontend/jurado   # o: cd frontend/jurado && npm test
```

8 tests `node:test` sin navegador (storage en memoria): persistencia, ACK,
backoff, mismo `idem` en reintentos, sin-transporte, `rechazada → FAILED`,
recuperación tras recarga y reintento manual.

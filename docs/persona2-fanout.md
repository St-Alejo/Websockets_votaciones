# Persona 2 — Tiempo real público + fan-out + métricas

Carpetas: `src/fanout/**`, `src/transport/**`, `src/metrics/**`, `src/plugins/tiempo-real/**`,
`load-test/**`.

## Qué reemplazar

Los stubs de `src/fanout/index.js` (`suscribir`, `desuscribir`), `src/metrics/index.js` y los
plugins `sse-publico.js` y `metrics.js`. Para probar sin Persona 1: `npm run emisor:falso`.

## Requerimientos a cargo

- [ ] RF-4 Fan-out por lotes cediendo el Event Loop + agregación por ventana; mensajes emitidos vs. cifra ingenua.
- [ ] RF-5 Índice tópico → conexiones con costo de alta/baja/recorrido documentado.
- [ ] RF-6 Reconexión con `ultimo_id`/`Last-Event-ID` sobre `stream:actas`; cuándo mandar snapshot.
- [ ] RF-9 Contrapresión con un cliente deliberadamente lento.
- [ ] RF-10 (parte) Reintento con backoff exponencial + jitter; gráfica de reconexiones/s con y sin él.
- [ ] RT-4, RT-7 Retraso del Event Loop y tablero de métricas por instancia.
- [ ] RT-8 Prueba de carga reproducible ≥ 20.000 conexiones (`load-test/`).
- [ ] Diseño del espacio de canales del backplane (global vs. por tópico) y su costo.
- [ ] Sección 7 del informe: mediciones WebSocket vs. SSE vs. polling.

## Decisiones y mediciones

_(Documentar aquí.)_

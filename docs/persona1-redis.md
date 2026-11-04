# Persona 1 — Infra + Redis core

Carpetas: `infra/`, `src/server.js`, `src/config.js`, `src/redis/**`, `src/dominio/**`,
`src/plugins/core/**`, `scripts/seed-catalogo.js`, `scripts/simular-actas.js`.

## Qué reemplazar

Los stubs de `src/dominio/index.js` (`registrarActa`, `aplicarActaVerificada`, `leerAcumulado`,
`ranking`, `snapshot`, `leerHistorialDesde`) por implementaciones en Redis, sin cambiar firmas.

## Requerimientos a cargo

- [ ] RF-1 Idempotencia (`idem:{k}` con TTL 24 h) y explicar la caída entre registrar y confirmar.
- [ ] RF-2 Correcciones fuera de orden: el resultado depende solo del conjunto de versiones.
- [ ] RF-3 Script Lua que revierte la versión previa y aplica la nueva en los 4 niveles a la vez.
- [ ] RF-6 (parte) `XADD stream:actas` dentro del mismo script, `MAXLEN` y memoria estimada.
- [ ] RF-10 (parte) Comportamiento degradado si Redis no responde (los jurados deben saberlo).
- [ ] Límite de tasa por jurado (`rl:{jurado}:{ventana}`) → 429.
- [ ] RT-1, RT-2, RT-3, RT-10: 8 instancias, sin afinidad, despliegue en la nube con URL pública.
- [ ] `seed-catalogo.js` y `simular-actas.js`.

## Decisiones y mediciones

_(Documentar aquí estructuras elegidas, costos y resultados.)_

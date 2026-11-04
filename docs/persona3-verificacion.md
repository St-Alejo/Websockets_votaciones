# Persona 3 — Verificación + presencia + WS de jurados y auditores + frontends

Carpetas: `src/verificacion/**`, `src/presencia/**`, `src/plugins/verificacion/**`, `frontend/**`.

## Qué reemplazar

Los stubs de `src/verificacion/index.js` (`tomarCaso`, `liberarCaso`), `src/presencia/index.js`
(`presentes`) y los plugins `ws-jurado.js` y `ws-auditor.js`.

## Requerimientos a cargo

- [ ] RF-7 Cola `cola:verificacion` + `lock:acta:{id}` con token, renovación mientras se trabaja,
      liberación segura (Lua que compara el token) y difusión por el canal `verificacion`.
- [ ] RF-8 Presencia con latido y TTL en `presencia:{auditor}`; sin auditores fantasma.
- [ ] RT-6 App del jurado con cola offline y reenvío automático (mismo `idem`).
- [ ] RT-9 Página pública usable en gama baja; reportar INP bajo carga (con Persona 2).
- [ ] Frontends: página pública (SSE), app del jurado (WS), consola de auditores (WS), panel del coordinador.

## Decisiones y mediciones

_(Documentar aquí.)_

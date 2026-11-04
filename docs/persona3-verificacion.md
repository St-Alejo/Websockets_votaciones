# Persona 3 — Verificación + presencia + WS de jurados y auditores + frontends

Carpetas: `src/verificacion/**`, `src/presencia/**`, `src/plugins/verificacion/**`, `frontend/**`.

> Nota de alcance: el enunciado pedía `src/ws/{jurado,auditor}.js`, `src/transport/sse.js`,
> `src/redis/client.js` y `docs/persona-3.md`. En el repo real esos archivos no existen:
> las rutas viven en `src/plugins/verificacion/` (autoload obliga), el SSE en
> `src/plugins/tiempo-real/` (P2), el cliente Redis en `src/redis/cliente.js` (P1) y este
> documento es `docs/persona3-verificacion.md` (CODEOWNERS). Se reutiliza todo sin duplicar.

## Requerimientos a cargo

- [x] RF-7 Cola `cola:verificacion` + `lock:acta:{id}` con token, renovación mientras se trabaja,
      liberación segura (Lua que compara el token) y difusión por el canal `verificacion`.
- [x] RF-8 Presencia con latido y TTL en `presencia:{auditor}`; sin auditores fantasma.
- [x] RT-5 Jurados y auditores por WebSocket; el público por SSE (consume P2).
- [x] RT-6 App del jurado con cola offline y reenvío automático (mismo `idem`).
- [ ] RT-9 Página pública usable en gama baja; reportar INP bajo carga (con Persona 2).
- [x] Frontends: página pública (SSE), app del jurado (WS), consola de auditores (WS).
- [ ] RT-10 Despliegue coordinado (ver § Despliegue; `infra/` es de P1, no se toca).

## 1. Arquitectura

```
Jurados ──WS /ws/jurado──▶ registrarActa (P1, idem) ──ACK real──▶ jurado
Auditores ──WS /ws/auditor──▶ tomarCaso/liberarCaso (Redis) ──Pub/Sub──▶ demás instancias
Público ──SSE /sse/publico (P2)──▶ snapshot Acumulado ──▶ página
```

La fuente de verdad es **Redis + backend**, nunca el estado local del navegador.
Las 8 instancias comparten cola, bloqueos y presencia; el Pub/Sub difunde eventos y
cada instancia reemite a SUS sockets.

## 2. Archivos y responsabilidad

| Archivo                                  | Responsabilidad                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/verificacion/cola.js`               | ZSET `cola:verificacion`: encolar (NX), prioridad, pendientes (ZREVRANGE), retirar/reintegrar, tamaño. Sin memoria local.                                                               |
| `src/verificacion/bloqueo.js`            | `SET NX PX` + token UUID; `LUA_LIBERAR` (compare-del) y `LUA_RENOVAR` (compare-pexpire). Nunca DEL directo.                                                                             |
| `src/verificacion/heartbeat.js`          | `iniciarHeartbeat` (intervalo = TTL/3, verifica token en Redis, auto-stop + `onPerdido`), `detenerHeartbeat`.                                                                           |
| `src/verificacion/index.js`              | Fachada contrato-intacta: `tomarCaso` (recorre por prioridad + NX), `liberarCaso`, `verCola` (+`asignada_a`), `encolarParaVerificacion`, `resolverCaso`; publica `verificacion`.        |
| `src/presencia/tracker.js`               | `presencia:{auditor}` SET EX 45 s (`{auditor,estado,instancia,acta_actual,desde,latido}`), `activos` vía SCAN, `detectarFantasmas`/`purgarExpirados` (60 s), `salir` publica `offline`. |
| `src/presencia/index.js`                 | Fachada intacta (`latido/salir/presentes`) + fallback local degradado sin Redis.                                                                                                        |
| `src/plugins/verificacion/ws-jurado.js`  | Valida `ActaEntrante`, anti-suplantación, ACK solo tras `registrarActa`, límite 64 KB.                                                                                                  |
| `src/plugins/verificacion/ws-auditor.js` | Identidad del query, un caso a la vez, heartbeat servidor, `completar`, snapshots y reemisión Pub/Sub. Re-sync `obtenerRedis()` desde `app.redis` (ver §4).                             |
| `frontend/auditor/`                      | Consola colaborativa vanilla ESM (cola en vivo, presencia, filtros).                                                                                                                    |
| `frontend/jurado/`                       | App offline-first: IndexedDB + backoff + stop-and-wait.                                                                                                                                 |
| `frontend/publico/`                      | Resultados vía SSE (solo consume P2).                                                                                                                                                   |

## 3. Redis y convenciones

- `cola:verificacion` ZSET, score = prioridad, **mayor = más urgente**; desempate
  lexicográfico determinista (Redis, a igual score). No duplica (NX).
- La cola **conserva el acta asignada**; el bloqueo decide disponibilidad. Así una
  caída no pierde actas (el lock expira y el acta vuelve a estar libre).
- `lock:acta:{id}` = `{"auditor","token"}` con PX 30 s. Liberar/renovar comparan el
  token en Lua: A-expira→B-toma→A-libera-viejo **falla** sin tocar lo de B.
- `presencia:{auditor}` EX 45 s; latido cliente 15 s; fantasma = sin latido 60 s.
  SCAN `presencia:*` basta para 120 auditores (sin clave índice extra).

## 4. Decisiones y hallazgos

1. **Sin módulo índice de presencia**: SCAN es barato a esta escala; no se amplía el
   contrato de claves compartidas.
2. **Re-sync `registrarClientes({redis: app.redis…})` en cada plugin**: bajo vitest,
   autoload carga los plugins en una instancia de módulo distinta y su `clientes`
   global quedaba sin registrar (los tests WS fallaban con "Redis no disponible"
   aunque el store funcionaba). En producción es el mismo objeto: inocuo. Sin esto,
   5/10 tests WS fallaban; con esto, 10/10 en <1 s.
3. **Un caso por auditor y stop-and-keep-lock al cerrar**: el bloqueo expira solo
   (permite reconexión con el token) en vez de liberarse en `close`.
4. **`completar` no aplica el veredicto al acumulado**: `aplicarActaVerificada`
   necesita el payload dudoso completo (pendiente P1); hoy retira + libera + publica.
5. **Frontends vanilla sin build** (decisión documentada en cada README): cero
   dependencias, servido estático inmediato; migrables a React sin cambiar el WS/SSE.
6. **Municipio/fecha de ingreso = n/d** en la consola: la cola guarda solo el id;
   pendiente del payload de P1. No se inventan datos.

## 5. Protocolo WS (extiende `docs/contratos.md` sin romperlo)

Jurado → `hola {jurado}`, `acta {acta}`. Servidor → `hola`, `respuesta {respuesta}`,
`error {json_invalido|acta_invalida|jurado_no_coincide|mensaje_muy_grande|registro_fallido|tipo_desconocido}`.
Auditor → `latido {acta?}`, `tomar`, `liberar {acta,token}`, `completar {acta,token}`,
`cola`, `presentes`. Servidor → `hola {instancia,cola,presentes}`, `caso {caso|null}`,
`liberado {acta,ok}`, `completado {acta,ok}`, `cola {cola,evento}`, `presentes {…}`,
`bloqueo_perdido {acta}`, `latido_ok`, `error {falta_auditor|ya_tienes_caso|peticion_invalida|operacion_fallida|…}`.

## 6. Offline-first (RT-6) y SSE (RT-5)

- Jurado: `offlineQueue.js` (`PENDING→SENDING→ACKNOWLEDGED|FAILED`), `idem` único
  reutilizado, stop-and-wait con ACK verificado, backoff + jitter, IndexedDB
  `jurado-offline.envios`. 9 tests `node:test`.
- Público: `EventSource` nativo, reanudación con `ultimo_id`, sin duplicados por
  `id:`, fusión de snapshot + futuros deltas de P2.

## 7. Variables de entorno, instalación, ejecución, pruebas

Env (ver `.env.example`): `REDIS_URL`, `PORT`, `INSTANCE_ID`, `LOG_LEVEL`.
Backend: `npm install`, `npm run redis:dev`, `npm run dev`.
Frontends: `npx --yes serve frontend/<app> -l 517{4,5,6}` (auditor/jurado/público).
Pruebas: `npm test` (58 backend: 29 humo + 29 P3), `npm test --prefix frontend/jurado`
(9 RT-6), `npm run lint`, `npm run format:check`. Sin Redis real local: los tests usan
fakes; el skip `redis.test.js` requiere `REDIS_URL` (CI lo provee).

## 8. Despliegue (RT-10, coordinado)

Sin cambios a `infra/` (P1): la imagen copia solo `src/`+`scripts/`; los frontends
estáticos deben servirse (propuesta: `location /auditor|/jurado|/` en `nginx.conf`
o hosting estático apuntando al mismo origen del WS/SSE) + coordinar URL pública,
`NGINX_PORT` y réplicas con P1, y deltas SSE con P2. Checklist pendiente conjunto:
build estático, CORS/origen único, 8 réplicas, prueba de carga de P2 con INP (RT-9).

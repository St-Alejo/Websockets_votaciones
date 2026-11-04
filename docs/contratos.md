# Contratos compartidos

Este documento explica en prosa lo que vive en `src/contratos/`. Es **compartido**: cualquier
cambio aquí o en `src/contratos/**` necesita un PR aprobado por las 3 personas (ver el final).

La idea es simple: cada persona trabaja detrás de una **fachada** (`index.js` de su carpeta) y
las demás solo dependen de las firmas descritas aquí. Mientras la implementación real no exista,
la fachada tiene un **stub** con la firma definitiva, marcado con `// STUB`, que imprime una
advertencia una sola vez (`[STUB] ...`). Reemplazar un stub no debe romper a nadie.

## 1. Claves de Redis — `src/contratos/keys.js`

Nadie arma nombres de claves a mano: siempre se usa el builder. Así un cambio de nombre se hace
en un solo lugar y un `grep` encuentra todos los usos.

| Builder                      | Clave resultante                                                     | Tipo        | Contenido                                                                                                    | Dueño              |
| ---------------------------- | -------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ | ------------------ |
| `acta(id)`                   | `acta:{id}`                                                          | HASH        | `version_aplicada`, `votos` (JSON), `sufragantes`, `estado` (`aplicada`\|`dudosa`), `jurado`, `recibo`, `ts` | P1                 |
| `actaVersiones(id)`          | `acta:{id}:versiones`                                                | libre       | Versiones recibidas (para revertir y para RF-2)                                                              | P1                 |
| `idem(k)`                    | `idem:{k}`                                                           | STRING      | Respuesta original (JSON de `RespuestaRegistro`), TTL `TTL_IDEM_S` = 24 h                                    | P1                 |
| `acum(nivel, id)`            | `acum:dep` \| `acum:mun:{id}` \| `acum:pue:{id}` \| `acum:mesa:{id}` | HASH        | Totales por candidato + sufragantes + mesas informadas                                                       | P1                 |
| `rank(nivel, id)`            | `rank:dep` \| `rank:mun:{id}` …                                      | ZSET        | candidato → votos (top N sin recorrer todo)                                                                  | P1                 |
| `catalogo(nivel, id)`        | `cat:dep:mesas` \| `cat:mun:{id}:mesas` …                            | libre       | Mesas del nivel (para el % informado)                                                                        | P1                 |
| `streamActas`                | `stream:actas`                                                       | STREAM      | Historial de actas aplicadas (RF-6)                                                                          | P1 escribe, P2 lee |
| `colaVerificacion`           | `cola:verificacion`                                                  | ZSET        | acta → prioridad                                                                                             | P3                 |
| `lockActa(id)`               | `lock:acta:{id}`                                                     | STRING      | Token del dueño del bloqueo, con expiración                                                                  | P3                 |
| `presencia(auditor)`         | `presencia:{auditor}`                                                | STRING/HASH | Estado del auditor; TTL renovado por latido                                                                  | P3                 |
| `rateLimit(jurado, ventana)` | `rl:{jurado}:{ventana}`                                              | STRING      | Contador por ventana                                                                                         | P1                 |

`NIVELES = ['dep', 'mun', 'pue', 'mesa']`. Para `dep` el id se omite.

## 2. Canales Pub/Sub — `src/contratos/canales.js`

| Constante              | Canal          | Mensaje (JSON)       | Publica | Escucha |
| ---------------------- | -------------- | -------------------- | ------- | ------- |
| `CANALES.ACTA_NUEVA`   | `acta:nueva`   | `EventoActaNueva`    | P1      | P2      |
| `CANALES.VERIFICACION` | `verificacion` | `EventoVerificacion` | P3      | P3      |
| `CANALES.PRESENCIA`    | `presencia`    | `EventoPresencia`    | P3      | P3      |

Pub/Sub **no tiene memoria**: es solo el aviso "algo cambió". La recuperación (RF-6) se apoya en
`stream:actas`, nunca solo en el canal.

**Tópicos públicos.** Un cliente se suscribe a `dep`, `mun:{id}`, `pue:{id}` o `mesa:{id}`. Las
funciones `topico(nivel, id)` y `parsearTopico(texto)` convierten entre ambas formas. El mismo
texto se usa en `GET /sse/publico?topico=` y en `snapshot(niveles[])`.

**Entradas de `stream:actas`** (`src/contratos/stream.js`): cada entrada tiene un único campo
`evento` con el JSON del `EventoActaNueva` **sin** `stream_id` (el id lo asigna `XADD`). Use
`camposStream(evento)` para escribir y `eventoDesdeEntrada([id, campos])` para leer.

```text
XADD stream:actas MAXLEN ~ N * evento '{"acta":"E14-176-0042-03","mun":11,"pue":176,"version":1,"tipo":"nueva"}'
```

## 3. Esquemas — `src/contratos/esquemas.js` (zod)

- **`ActaEntrante`**: el JSON de la sección 3.1 del enunciado: `acta` (`E14-puesto-mesa-corporacion`),
  `mesa`, `puesto`, `municipio`, `version` (≥ 1), `jurado`, `ts_cierre`, `votos`
  (`C1..Cn`, `BLANCO`, `NULO`, `NO_MARCADO`, enteros ≥ 0), `sufragantes`, `hash_foto`, `idem`.
- **`RespuestaRegistro`**: `{ estado, acta, version, recibo, version_vigente?, motivo? }` con
  `estado ∈ registrada | duplicada | version_obsoleta | conflicto | dudosa | rechazada`.
  `recibo` es `null` solo cuando `estado = rechazada`.
- **`EventoActaNueva`**: `{ stream_id, acta, mun, pue, version, tipo: nueva | correccion }`.
- **`EventoVerificacion`**: `{ tipo: encolada | asignada | liberada | resuelta, acta, auditor? }`.
- **`EventoPresencia`**: `{ auditor, estado: online | offline, instancia, acta_actual?, desde? }`
  (`desde` en ms epoch).
- **`Acumulado`**: `{ nivel, id, votos, sufragantes, mesas_informadas, mesas_totales, porcentaje_informado }`.
- **`FilaRanking`**: `{ candidato, votos }`.
- **`Snapshot`**: `{ niveles: { [topico]: Acumulado }, stream_id }`. El `stream_id` es el punto
  exacto del stream que ya está incluido en la fotografía: el cliente continúa desde ahí.

### Regla contable

> **suma de votos (candidatos + BLANCO) + NULO + NO_MARCADO = sufragantes**

En el ejemplo del PDF: 184 + 97 + 311 + 22 + 9 + 4 = 627. Un acta que **no cuadra no se
rechaza**: es estructuralmente válida, se responde `dudosa` y pasa a la cola de verificación
humana. `rechazada` es solo para JSON que no cumple `ActaEntrante`. La función
`cumpleReglaContable(acta)` es la única implementación de la regla.

## 4. Interfaces entre personas — `src/contratos/interfaces.js`

Las firmas están en JSDoc. `FIRMAS` lista módulo → función → número de parámetros y
`test/humo/contratos.test.js` lo verifica (por eso **no** se usan valores por defecto en estas
firmas: alteran `Function.length`).

| Persona | Importar de                 | Función                                | Devuelve                                                                           |
| ------- | --------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| P1      | `src/dominio/index.js`      | `registrarActa(acta)`                  | `Promise<RespuestaRegistro>` (nunca lanza por datos inválidos)                     |
| P1      | `src/dominio/index.js`      | `aplicarActaVerificada(acta, version)` | `Promise<{ aplicada, stream_id? }>`                                                |
| P1      | `src/dominio/index.js`      | `leerAcumulado(nivel, id)`             | `Promise<Acumulado>`                                                               |
| P1      | `src/dominio/index.js`      | `ranking(nivel, id, topN)`             | `Promise<FilaRanking[]>`                                                           |
| P1      | `src/dominio/index.js`      | `snapshot(niveles[])`                  | `Promise<Snapshot>`                                                                |
| P1      | `src/dominio/index.js`      | `leerHistorialDesde(streamId, max)`    | `Promise<{ eventos, stream_id, recortado? }>` — `recortado: true` ⇒ pedir snapshot |
| P2      | `src/fanout/index.js`       | `suscribir(conexion, topico)`          | `void` (síncrona)                                                                  |
| P2      | `src/fanout/index.js`       | `desuscribir(conexion, topico)`        | `void` (síncrona)                                                                  |
| P3      | `src/verificacion/index.js` | `tomarCaso(auditor)`                   | `Promise<{ acta, token, ttl_ms } \| null>`                                         |
| P3      | `src/verificacion/index.js` | `liberarCaso(auditor, acta, token)`    | `Promise<boolean>` — `false` si el token ya no es el dueño                         |
| P3      | `src/presencia/index.js`    | `presentes()`                          | `Promise<EventoPresencia[]>`                                                       |

Los clientes Redis se obtienen con `app.redis` / `app.redisSub` dentro de un plugin, o con
`obtenerRedis()` / `obtenerRedisSub()` de `src/redis/cliente.js` desde un módulo de dominio.

## 5. Endpoints

Todas las respuestas llevan el header **`X-Instance-Id`** (instancia que atendió).

| Método y ruta                                  | Dueño | Descripción                                                                                                                                                                                       |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /actas`                                  | P1    | Cuerpo `ActaEntrante` → `RespuestaRegistro`. HTTP: `registrada` 201, `duplicada` 200, `version_obsoleta` 200, `dudosa` 202, `conflicto` 409, `rechazada` 400. Exceso de tasa: 429 (pendiente P1). |
| `GET /acumulado/:nivel/:id`                    | P1    | `Acumulado`. Para el departamento: `GET /acumulado/dep`.                                                                                                                                          |
| `GET /ranking/:nivel/:id?top=10`               | P1    | `FilaRanking[]` (máx. 100).                                                                                                                                                                       |
| `GET /instancia`                               | P1    | `{ instancia, pid, uptime_s }`.                                                                                                                                                                   |
| `GET /salud`                                   | P1    | 200 `{ estado: 'ok', redis: 'ok' }` o 503 `{ estado: 'degradado', redis: 'sin_respuesta' }`.                                                                                                      |
| `GET /sse/publico?topico=mun:11&ultimo_id=...` | P2    | SSE. Primer evento `snapshot` con `id: <stream_id>`. `ultimo_id` (o el header `Last-Event-ID`) permite reanudar (RF-6).                                                                           |
| `GET /metrics`                                 | P2    | Formato Prometheus, por instancia.                                                                                                                                                                |
| `WS /ws/jurado`                                | P3    | Ver protocolo abajo.                                                                                                                                                                              |
| `WS /ws/auditor?auditor=AUD-7`                 | P3    | Ver protocolo abajo.                                                                                                                                                                              |

### Protocolo WS inicial (P3 puede refinarlo por PR)

Todos los mensajes son JSON con un campo `tipo`. Al conectar el servidor envía
`{ tipo: 'hola', instancia, ... }` (en WS no hay headers por mensaje).

- `/ws/jurado`: cliente → `{ tipo: 'acta', acta: ActaEntrante }`; servidor →
  `{ tipo: 'respuesta', respuesta: RespuestaRegistro }`.
- `/ws/auditor`: cliente → `{ tipo: 'tomar' }` | `{ tipo: 'liberar', acta, token }` |
  `{ tipo: 'latido', acta? }`; servidor → `{ tipo: 'hola', cola, presentes }` |
  `{ tipo: 'caso', caso }` | `{ tipo: 'liberado', acta, ok }` | `{ tipo: 'latido_ok' }`.
- Errores: `{ tipo: 'error', motivo }`.

## 6. Cómo agregar rutas sin tocar `server.js`

`src/server.js` carga con `@fastify/autoload` todo `src/plugins/**` (subcarpetas incluidas, **sin**
prefijo de carpeta: la ruta es exactamente la que declara el plugin). Cada archivo exporta por
defecto `async function (app) { app.get(...) }`. Reglas:

- Cada persona crea archivos solo en **su** subcarpeta: `core/` (P1), `tiempo-real/` (P2),
  `verificacion/` (P3).
- **No** crear `index.js` dentro de `src/plugins/**`: autoload cargaría solo ese archivo de la carpeta.
- Los `*.test.js` dentro de `src/plugins` se ignoran.
- Si una respuesta hace `reply.hijack()` (SSE), `X-Instance-Id` ya viene puesto en `reply.raw`.

## 7. Cómo proponer un cambio de contrato

1. Abra un issue o escriba en el canal del grupo: qué firma/esquema/clave cambia y por qué.
2. Rama `contrato/<descripcion-corta>` desde `main`. En el **mismo PR**: cambie `src/contratos/**`,
   actualice este documento y adapte los stubs/llamadas afectados para que `npm test` siga en verde.
3. Prefiera cambios **compatibles**: agregar un campo opcional antes que renombrar; agregar una
   función nueva antes que cambiar la firma de una existente.
4. El PR necesita la aprobación de **las 3 personas** (CODEOWNERS lo exige). Márquelo en la
   plantilla: "¿Cambia contratos? Sí".
5. Al fusionar, avise: todos hacen `git pull --rebase origin main` antes de seguir.

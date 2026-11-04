# Persona 1 — Infraestructura y Redis core

Justificación técnica de la capa de datos para el informe. Cubre RF-1, RF-2, RF-3, la parte de
RF-6 que escribe el historial, la parte de RF-10 de degradación, el límite de tasa y RT-1/2/3/10.
Todas las cifras de este documento salen de mediciones propias (sección 10), no de estimaciones.

## 1. Qué hay y dónde

| Archivo                             | Papel                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `src/redis/cliente.js`              | Clientes ioredis: fallo rápido, timeout por comando, reconexión con jitter      |
| `src/redis/scripts/registrar.lua`   | Registro atómico: idempotencia + correcciones + 4 niveles + stream + pub/sub    |
| `src/redis/scripts/snapshot.lua`    | Lectura consistente de varios niveles + último `stream_id`                      |
| `src/redis/scripts/limite-tasa.lua` | Contador por jurado y ventana                                                   |
| `src/redis/actas.js`                | `registrar()` y `aplicarVerificada()` (invocan el script)                       |
| `src/redis/acumulados.js`           | Snapshot, acumulado y ranking                                                   |
| `src/redis/historial.js`            | `leerDesde(cursor)` y `ultimoId()` sobre `stream:actas`                         |
| `src/redis/idempotencia.js`         | Hash canónico del contenido del acta                                            |
| `src/redis/rateLimit.js`            | `consumir(jurado)` → `ErrorLimiteTasa`                                          |
| `src/dominio/index.js`              | Fachada pública con las firmas del contrato                                     |
| `src/dominio/errores.js`            | `ErrorRedisNoDisponible` (503) y `ErrorLimiteTasa` (429)                        |
| `src/dominio/catalogo.js`           | Catálogo sintético determinista (40 municipios, 1.842 puestos, 6.400 mesas)     |
| `src/plugins/core/*.js`             | `POST /actas`, `GET /acumulado`, `GET /ranking`, `GET /salud`, `GET /instancia` |
| `scripts/seed-catalogo.js`          | Carga `cat:...:mesas`                                                           |
| `scripts/simular-actas.js`          | Jornada completa + verificación del acumulado + medición de memoria             |
| `infra/`                            | Dockerfile, compose (Redis + seed + 8 réplicas + nginx), nginx.conf             |

Los nombres de claves y canales están en `src/contratos/keys.js` y `src/contratos/canales.js`
(única fuente de verdad, compartida con el equipo) y se explican en `docs/contratos.md`.

## 2. Cómo ejecutarlo

```bash
npm run redis:dev                                   # Redis 7 local (AOF)
npm test                                            # tests contra Redis real
node scripts/seed-catalogo.js                       # catálogo
LIMPIAR=1 MEDIR=1 REDIS_URL=redis://localhost:6379/5 node scripts/simular-actas.js
```

Entorno completo (8 réplicas) y simulación por HTTP a través de nginx:

```bash
npm run compose:up                                  # NGINX_PORT=8081 si 8080 está ocupado
docker compose -f infra/docker-compose.yml run --rm --no-deps \
  -e MODO=http -e URL=http://nginx -e REDIS_URL=redis://redis:6379 -e CONCURRENCIA=32 \
  app node scripts/simular-actas.js
```

Variables de entorno de la app: `REDIS_URL`, `PORT`, `INSTANCE_ID` (por defecto el hostname),
`REDIS_COMMAND_TIMEOUT_MS` (1000), `RL_MAX` (20), `RL_VENTANA_MS` (60000), `STREAM_MAXLEN` (10000).

## 3. Acumulados

**Estructuras.**

- `acum:mesa:{id}`, `acum:pue:{id}`, `acum:mun:{id}`, `acum:dep` → **HASH** con un campo por
  voto (`C1..Cn`, `BLANCO`, `NULO`, `NO_MARCADO`) más `sufragantes` e `informadas`.
- `rank:pue:{id}`, `rank:mun:{id}`, `rank:dep` → **ZSET** candidato → votos.
- `cat:{nivel}:mesas` → **STRING** con el total de mesas del catálogo (denominador del % informado).

**Por qué.** El HASH se actualiza con `HINCRBY` sin leer antes (no hay read-modify-write en la
aplicación) y se lee entero con `HGETALL` en O(campos). El ranking de candidatos sale de un ZSET
ordenado: `ZREVRANGE 0 N-1` devuelve el top N en O(log M + N) sin recorrer todos los candidatos.
No hay `rank:mesa:*`: una mesa tiene pocos candidatos y se ordena su HASH en memoria. Así se
ahorran 6.400 ZSET.

**Costos** (V = campos de voto, C = candidatos; en la simulación V = 8, C = 5):

| Operación              | Costo                                              |
| ---------------------- | -------------------------------------------------- |
| Aplicar un acta nueva  | 4·(V+2) `HINCRBY` + 3·C `ZINCRBY` → O(V + C·log M) |
| Aplicar una corrección | el doble (revertir + aplicar)                      |
| Leer un nivel          | O(V) `HGETALL` + O(1) `GET`                        |
| Top N de un nivel      | O(log M + N)                                       |
| % informado            | O(1): `informadas / cat:...:mesas`                 |

**Memoria medida** (jornada completa): `acum:mesa:*` 168 B/clave (5.950 claves, 976 KB),
`acum:pue:*` 168 B (300 KB), `acum:mun:*` 184 B, `rank:*` 103 B/clave (188 KB), `cat:*` 64 B (118 KB).

## 4. Operación atómica compuesta (RF-3)

Un único script, `registrar.lua`, hace en una sola ejecución todo esto: verifica idempotencia,
decide la versión, revierte la anterior, aplica la nueva en los 4 niveles y los 3 rankings,
actualiza `informadas`, encola las dudosas, hace `XADD` al stream y `PUBLISH` en `acta:nueva`.

**Por qué no bastan varios comandos seguidos desde Node.**

- **Comandos sueltos:** entre el `HINCRBY` del municipio y el del puesto otro cliente puede leer
  y ver un municipio que ya incluye el acta y un puesto que todavía no. Además, si la instancia
  muere a la mitad, el acta queda aplicada a medias para siempre.
- **Pipeline:** solo agrupa el envío por la red. Redis puede intercalar comandos de otros
  clientes entre los del pipeline, y una caída a la mitad deja la misma escritura parcial.
- **MULTI/EXEC:** sí es atómico, pero no puede **decidir**: los comandos se encolan sin conocer
  los resultados de los anteriores. Para saber si una versión es nueva, obsoleta o duplicada
  habría que leer antes y usar `WATCH` con reintentos optimistas. Con 8 instancias compitiendo
  por la misma acta en un reenvío, eso significa reintentos y más idas y vueltas.
- **Lua:** Redis ejecuta el script completo sin intercalar otro comando, y la lógica de
  decisión vive junto a los datos. Leer, decidir y escribir es un solo paso indivisible.

**Restricciones que impone Lua y cómo las respetamos.**

1. **Bloquea Redis mientras corre.** El script es O(V + C), sin bucles sobre datos que crecen.
   Medido: **100 µs de media, p99 = 295 µs, p99.9 = 786 µs** por llamada (`INFO commandstats` y
   `latencystats`, 7.108 llamadas). En la ráfaga de 300 actas/min eso es 0,05 % del tiempo de Redis.
2. **Todas las claves en `KEYS`.** Las 12 claves se calculan en Node y se pasan declaradas;
   nada se arma dentro del script. Para migrar a Redis Cluster harían falta hash tags (p. ej.
   `{dep}`) porque las claves deben caer en el mismo slot. La decisión queda documentada aunque
   hoy usemos una instancia.
3. **Sin no determinismo.** El recibo y el `ts` los genera Node y llegan por `ARGV`. `XADD *`
   está permitido porque Redis 7 replica los efectos del script, no el script.
4. **Sin efectos externos ni esperas.** El script no hace E/S ni bloqueos (`BLPOP`, etc.).
5. **Si falla a la mitad no hay rollback** de lo ya escrito. Por eso toda la validación de entrada
   (zod, regla contable, hash) se hace **antes**, en Node, y el script solo ejecuta caminos
   válidos. Un error de Lua sería un bug (HTTP 500), no un estado esperado.

**Lectura consistente.** `snapshot.lua` (marcado `no-writes`) lee los HASH de los niveles
pedidos, sus totales de catálogo y el último id del stream en una sola ejecución. Como las
escrituras también son atómicas, la fotografía corresponde a un instante entre dos actas y su
`stream_id` es exactamente el último evento incluido. Persona 2 continúa el historial desde ahí
sin huecos ni duplicados.

## 5. Idempotencia (RF-1)

**Dos capas, las dos dentro del mismo script que escribe:**

1. `idem:{k}` → STRING `{"r": respuesta, "h": hash}` con **TTL 24 h**. Es el camino rápido para
   el reintento típico (misma petición, mismo `idem`).
2. `acta:{id}:versiones` → HASH `{v}` = hash del contenido y `{v}:r` = respuesta original. Es la
   defensa de fondo: si `idem:{k}` **expiró** (o el cliente perdió su estado y generó otro
   `idem`), el par (acta, versión) con el mismo hash sigue respondiendo `duplicada` con el recibo
   original. Con otro hash responde `conflicto`. En ese momento la clave `idem` se vuelve a crear.

`idem` es una optimización; la garantía la da la deduplicación por (acta, versión). El hash del
contenido usa municipio, puesto, mesa, votos (con claves ordenadas) y sufragantes. No incluye
`idem`, `jurado`, `ts_cierre` ni `hash_foto`: el mismo conteo reenviado desde otro dispositivo
es la misma acta.

**Por qué en el mismo script.** Si la verificación y la escritura fueran comandos separados,
dos instancias que reciben el mismo reintento a la vez podrían ver las dos "no existe" y aplicar
dos veces. El test obligatorio 1 lo cubre: 5 clientes distintos envían la misma acta en paralelo
y el resultado es exactamente 1 `registrada` y 4 `duplicada`, todas con el mismo recibo, y el
acumulado suma una sola vez.

**Respuesta siempre inequívoca:** `registrada`, `duplicada` (con el recibo original y el estado
original en `motivo`), `version_obsoleta` (con `version_vigente`), `conflicto`, `dudosa` o
`rechazada`. Si Redis no responde, HTTP 503 explícito (sección 8).

**Costo y memoria.** O(1) para verificar. `idem:*` ocupa 252 B/clave: 6.641 claves ≈ 1,6 MB por
jornada, que se liberan solos a las 24 h. `acta:*:versiones` ocupa 296 B/acta (1,8 MB) y no
expira, porque es la defensa de fondo.

### Caída entre registrar y confirmar

Escenario: la instancia ejecuta el script (el acta queda escrita y sumada) y muere antes de
enviar la respuesta HTTP. El jurado no ve confirmación y su app reintenta con el mismo `idem`.
El balanceador manda el reintento a **otra** instancia, que ejecuta el mismo script. El script
encuentra `idem:{k}` o el (acta, versión) y responde `duplicada` con el **recibo original**. El
jurado queda con certeza de que el acta quedó registrada, y no se sumó dos veces.

Esto es **entrega al menos una vez + procesamiento idempotente = efecto exactamente una vez**.
La escritura es atómica: o se aplicó todo o nada, nunca a medias. El caso intermedio (Redis
ejecutó, pero el cliente no recibió la respuesta) también está probado: el test de "Redis
colgado" congela la conexión. El jurado recibe 503 y, al recuperarse Redis, el comando que ya
estaba en camino se ejecuta. El reintento devuelve `duplicada` y el acumulado no cambia.

## 6. Correcciones y convergencia (RF-2)

**Regla:** el acumulado de cada acta refleja su **versión válida más alta** recibida.

- **Versión mayor que la aplicada y válida:** se revierten los votos de la anterior (guardados
  en `acta:{id}.votos`) en los 4 niveles y rankings, y se aplican los nuevos, en el mismo script.
- **Versión menor que la aplicada:** responde `version_obsoleta`, se registra y no cambia nada.
  Así, si la v3 ya se aplicó, la v2 tardía no retrocede el estado.
- **`informadas` sube solo la primera vez** que una mesa aplica una versión válida.
- **Versión más alta dudosa:** no toca el acumulado. Se guarda su contenido
  (`acta:{id}:versiones.{v}:datos`), entra en `cola:verificacion` y queda marcada en
  `acta:{id}.version_dudosa`. El acumulado sigue con la versión válida anterior, si existe.
  Cuando un auditor la aprueba, Persona 3 llama `aplicarActaVerificada(acta, v)`, que la aplica
  como cualquier corrección. Si después llega una versión válida mayor que la dudosa, la dudosa
  sale de la cola porque ya no importa.

**Por qué no depende del orden.** El estado final de un acta es una función del **conjunto** de
versiones recibidas: el máximo de las válidas. El máximo es conmutativo y asociativo. El estado
de la cola también lo es: un acta está pendiente si y solo si su dudosa más alta supera a su
válida más alta. El test obligatorio 2 lo comprueba de forma exhaustiva. Con 6 mensajes de 2
actas (v1/v2/v3 válidas en una; v1, v2 válidas y v3 dudosa en otra), las **720 permutaciones**
producen exactamente el mismo estado en los 4 niveles, los rankings, las actas y la cola. La
simulación de la jornada con 32 envíos concurrentes y 30 % de correcciones fuera de orden
termina en el acumulado esperado.

## 7. Historial para recuperación (RF-6, parte de escritura)

**Estructura:** `stream:actas` (Redis Stream). Cada acta aplicada (nueva, corrección o
verificada) hace `XADD` **dentro del mismo script** que actualiza los acumulados. Por eso el
stream y los acumulados nunca divergen.

**Por qué un Stream y no solo Pub/Sub.** Pub/Sub no tiene memoria: lo publicado mientras un
cliente o un servidor estaba desconectado se pierde. El Stream conserva el historial con **ids
monótonos** `ms-secuencia` que el cliente usa como cursor (`Last-Event-ID`). El canal
`acta:nueva` sigue existiendo como aviso de baja latencia y lleva el mismo `stream_id`.

**Lectura.** `leerHistorialDesde(cursor, max)` usa `XRANGE (cursor + COUNT max`, que cuesta
O(log N + M) con M = eventos devueltos, y pagina con `hay_mas`.

**Retención y política de recorte.** `XADD ... MAXLEN ~ 10000`:

- El recorte aproximado (`~`) borra nodos enteros del radix tree. Es mucho más barato que el
  exacto y el stream nunca queda por debajo de 10.000 entradas.
- 10.000 entradas cubren la **jornada entera** (6.053 eventos aplicados en la simulación,
  incluidas las correcciones). Un cliente desconectado 30 s, o incluso horas, recupera el
  detalle sin descargar todo.
- Si el cursor quedó antes de lo recortado, `leerHistorialDesde` devuelve `recortado: true` y el
  cliente pide un snapshot. Se detecta con `XINFO STREAM`: hubo recorte
  (`entries-added > length`) y el cursor es anterior a `first-entry`. Detalle verificado: en
  Redis 7.4 `XTRIM` no actualiza `max-deleted-entry-id` (solo `XDEL` lo hace), así que no se
  puede confiar solo en ese campo.
- No hay expiración por tiempo: el stream vive lo que dura la jornada y se archiva o borra al
  final.

**Memoria medida:** 578 KB para 6.053 entradas, unos **98 B/entrada**. Con el tope de 10.000
son ≈ 1 MB. Retener una semana completa de jornadas seguiría siendo trivial.

## 8. Degradación (RF-10, parte de Persona 1)

**Objetivo:** que nunca haya un estado silencioso en el que el jurado cree que transmitió y
nadie recibió nada.

- El cliente de la app usa `enableOfflineQueue: false`. Si la conexión está caída, el comando
  falla **de inmediato** en vez de quedar encolado en memoria y colgar la petición.
- Usa también `commandTimeout` (1 s). Si Redis está colgado (conexión abierta sin respuesta),
  el comando falla a los 1.000 ms.
- Esos errores se traducen a `ErrorRedisNoDisponible`. `POST /actas` responde **503** con
  `Retry-After` y el cuerpo `{ estado: "no_registrada", reintentar: true, motivo }`. El motivo
  explica que el reintento con el mismo `idem` es seguro. Un bug de programación (`TypeError`)
  sigue siendo 500 y no se disfraza de 503.
- `/salud` hace PING con un límite de 500 ms y responde 503 `degradado`. `/instancia` sigue
  respondiendo: la instancia está viva aunque degradada.
- La reconexión usa backoff exponencial acotado a 2 s **con jitter**, para que las 8 instancias
  no reconecten sincronizadas.
- El cliente suscriptor (`redisSub`) sí usa cola offline y se vuelve a suscribir solo tras
  reconectar.

**Medido:**

| Escenario                                             | Resultado                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Test: Redis caído (puerto sin servidor)               | 503 en < 300 ms (verificado por el test)                                                         |
| Test: Redis colgado (conexión congelada)              | 503 en ≤ 1,3 s con timeout de 400 ms; al recuperarse, el reintento da `duplicada`                |
| Compose: `docker compose stop redis` + POST vía nginx | **503 en 18 ms**, `/salud` → `degradado`                                                         |
| Compose: `docker compose start redis`                 | las 8 réplicas reconectan solas; el reintento queda `registrada`; los datos previos siguen (AOF) |

## 9. Límite de tasa

**Estructura:** `rl:{jurado}:{ventana}`, un STRING contador con TTL. La ventana es
`floor(ahora / RL_VENTANA_MS)`. `INCR` + `PEXPIRE` van en un script, porque separados, si la
instancia muere entre ambos, el contador quedaría sin TTL y el jurado bloqueado para siempre.

**Política:** 20 envíos por minuto por credencial de jurado. Un jurado legítimo envía 1 acta, con
algunos reintentos y quizá una corrección. Al excederse recibe **HTTP 429** con `Retry-After`
(segundos que faltan para que termine la ventana) y `{ error: "limite_tasa", reintentar_en_s }`.
El conteo se hace después de validar el JSON, porque la credencial sale del acta. Los
reintentos cuentan, para frenar a un cliente desbocado que reintenta en bucle.

**Costo:** O(1). Memoria: una clave pequeña por jurado activo en la ventana, que expira sola.
**Limitación aceptada:** con ventana fija, en el borde entre dos ventanas pueden pasar hasta
2×max envíos. Basta para frenar abusos; una ventana deslizante (ZSET por jurado) costaría
O(log n) y más memoria sin beneficio real aquí.

## 10. Mediciones de la jornada completa

`scripts/simular-actas.js` con la semilla 2026:

- **Envíos:** 7.109 en total: 6.400 actas, 468 reenvíos con el mismo `idem`, 61 con `idem`
  nuevo y 180 correcciones, el 30 % fuera de orden.
- **Perfil:** 55 % en los primeros 40 minutos, con ráfagas.
- **Votación:** 5 candidatos y 7,5 % de actas dudosas.

**Resultado:** acumulado departamental **idéntico al esperado**. 5.950 mesas informadas (las
otras 450 son dudosas pendientes de verificación).

| Escenario                                                    | Rendimiento                       |
| ------------------------------------------------------------ | --------------------------------- |
| Directo a Redis, 16 concurrentes                             | ~5.400 envíos/s                   |
| HTTP → nginx → 8 réplicas, 32 concurrentes, una sola máquina | ~1.700 envíos/s; ~889 por réplica |
| Requerido en la ráfaga del enunciado                         | 300 actas/min = **5/s**           |

**Memoria por estructura** (`MEMORY USAGE ... SAMPLES 0` sobre todas las claves):

| Estructura          | Claves | KB (por defecto) | KB (`hash-max-listpack-value 128`) | B/clave (ajustado) |
| ------------------- | -----: | ---------------: | ---------------------------------: | -----------------: |
| `acta:*`            |  6.400 |          5.082,2 |                            1.929,7 |                309 |
| `acta:*:versiones`  |  6.400 |          2.603,8 |                            1.852,4 |                296 |
| `idem:*`            |  6.641 |          1.635,0 |                            1.635,0 |                252 |
| `acum:mesa:*`       |  5.950 |            976,2 |                              976,2 |                168 |
| `acum:pue:*`        |  1.831 |            300,4 |                              300,4 |                168 |
| `acum:mun:*`        |     40 |              7,2 |                                7,2 |                184 |
| `acum:dep`          |      1 |              0,2 |                                0,2 |                184 |
| `rank:*`            |  1.872 |            188,1 |                              188,1 |                103 |
| `cat:*`             |  1.883 |            117,7 |                              117,7 |                 64 |
| `stream:actas`      |      1 |            581,1 |                              578,1 |     98 por entrada |
| `cola:verificacion` |      1 |             46,0 |                               45,6 |      ~104 por acta |
| **Total**           |        |     **11.537,7** |                        **7.630,5** |                    |

`used_memory` del servidor: 13,9 MB con la configuración por defecto y **10,1 MB** ajustada.

**Hallazgo.** `acta:{id}` guarda los votos como JSON, de unos 80 bytes. Eso supera el límite
por defecto de 64 bytes de `hash-max-listpack-value`, y Redis convierte el HASH de `listpack`
(compacto) a `hashtable`: 813 B por acta. Subir el límite a 128 los mantiene en listpack
(309 B) y ahorra un **34 %** del total sin tocar el código. Está aplicado en ambos compose.

Conclusión: la jornada entera cabe en ~10 MB. La memoria de Redis no es una restricción. Lo
escaso es el ancho de banda del fan-out hacia 400.000 clientes, que resuelve Persona 2.

## 11. Sin sesiones pegajosas (RT-2) y sin comunicación entre instancias (RT-3)

nginx reparte en round-robin **sin** `ip_hash`, `hash`, `sticky` ni cookies. `zone` comparte el
estado del round-robin entre workers; sin ella, cada uno de los 22 workers empezaba por la misma
réplica. Verificado: peticiones seguidas recorren las 8 réplicas en orden, y en la simulación
cada réplica atendió 888–889 de 7.109 envíos.

**Qué problemas evita:**

- **Reparto desigual por NAT:** miles de jurados detrás del mismo operador móvil comparten IP,
  y `ip_hash` los mandaría a todos a una réplica.
- **Puntos de estado únicos:** si una réplica muere, no hay sesiones "atadas" a ella que se
  pierdan. Cualquier otra atiende el reintento con el mismo resultado gracias a la idempotencia
  en Redis.
- **Despliegues y escalado sin drenar sesiones:** se agregan o quitan réplicas sin migrar estado.

**Qué problemas crea (y cómo los resolvemos):**

- **Ningún estado puede vivir en memoria de la instancia.** Idempotencia, versiones, bloqueos
  (Persona 3), presencia y límites de tasa van en Redis. Por eso los stubs en memoria del
  esqueleto eran incorrectos con 8 réplicas.
- **Peticiones consecutivas del mismo cliente caen en instancias distintas**, posiblemente
  carreras entre reintentos simultáneos. Lo resuelve la atomicidad del script: el test 1 simula
  justo eso con 5 clientes.
- **Un cliente que reconecta cae en otra réplica, que no conoce su posición.** El cliente lleva
  su cursor (`stream_id`) y cualquier instancia reanuda desde el Stream compartido.
- **Redis es dependencia de todo** y punto único de falla. Se mitiga con degradación explícita
  (sección 8), persistencia (sección 12) y, en producción, una réplica con failover.

**RT-3:** ninguna instancia conoce a las otras. No hay direcciones entre réplicas ni llamadas
HTTP internas. Toda la coordinación pasa por Redis (scripts, Stream y Pub/Sub).

## 12. Persistencia de Redis

- **Configuración:** una instancia primaria con **AOF `appendfsync everysec`** y el preámbulo
  RDB por defecto (`aof-use-rdb-preamble yes`). Al reiniciar se carga la foto RDB y se
  reaplica la cola del AOF.
- **Comprobado:** se detuvo y reinició Redis en el compose y las 5.950 mesas informadas seguían ahí.
- **Qué se puede perder:** como máximo ~1 s de escrituras ante un corte del sistema operativo o
  de la máquina. Un fallo solo del proceso Redis no pierde nada, porque el kernel ya tiene los
  datos.
- **Riesgo residual:** un acta confirmada como `registrada` en ese último segundo podría no
  existir tras un corte de energía. El jurado tiene su recibo y el acta se puede reenviar con el
  mismo `idem` (el resultado sería `registrada` de nuevo, sin duplicar).
- **Por qué `everysec` y no `always`:** `always` hace fsync en cada escritura, unas 10× más
  lento. Para un preconteo **informativo** (el conteo oficial es manual) el balance favorece a
  `everysec`. Si se quisiera cerrar el riesgo, la opción correcta es una réplica con
  `WAIT 1 100` después del script, antes de confirmar al jurado, y no `always`.
- **Sin Redis Cluster:** el volumen (unos 10 MB, 5 escrituras/s) no lo justifica, y Cluster
  complica los scripts multi-clave. Igual se pasan todas las claves por `KEYS` para que la
  decisión sea migrable (sección 4).

## 13. Despliegue en la nube (RT-1, RT-10)

La forma más directa y reproducible es una VM con Docker usando el **mismo** compose.
Funciona en AWS EC2, GCP Compute Engine, Azure o DigitalOcean; basta una de 2 vCPU y 4 GB
para la demostración.

```bash
# En la VM (Ubuntu 24.04), con el puerto 80 abierto en el firewall/grupo de seguridad:
curl -fsSL https://get.docker.com | sh
git clone https://github.com/St-Alejo/Websockets_votaciones.git && cd Websockets_votaciones
NGINX_PORT=80 docker compose -f infra/docker-compose.yml up -d --build
# Verificación pública (RT-1/RT-2): IDs distintos desde cualquier cliente
for i in $(seq 1 16); do curl -s http://<IP-PUBLICA>/instancia; echo; done
```

**Para producción real:**

- **Redis gestionado** (ElastiCache, Memorystore o Upstash) con réplica y failover.
  `REDIS_URL` apunta allí y se quita el servicio `redis` del compose. Si el proveedor exige TLS,
  la URL es `rediss://...`.
- **Escalar en horizontal:** las réplicas en varias VMs detrás del balanceador del proveedor
  (ALB o Cloud Load Balancing) con afinidad **desactivada** y timeouts de inactividad largos
  (≥ 1 h) para SSE y WebSocket.
- **Límites del sistema:** `ulimit -n` alto (≥ 200.000) en las VMs que sostienen conexiones
  públicas.

## 14. Tests (Redis real, sin mocks)

| #   | Requisito                                                          | Test                                                       |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| 1   | 5 envíos paralelos por clientes distintos suman una vez            | `src/redis/actas.test.js`                                  |
| 2   | Todas las permutaciones (720) dan el mismo acumulado               | `src/redis/actas.test.js`                                  |
| 3   | Un lector continuo nunca ve municipio ≠ suma de sus puestos        | `src/redis/acumulados.test.js` (4 escritores concurrentes) |
| 4   | Idem borrado → `duplicada`, no suma                                | `src/redis/actas.test.js`                                  |
| 5   | No cuadra → `dudosa`, no suma, en `cola:verificacion`              | `src/redis/actas.test.js`                                  |
| 6   | Límite de tasa → 429 con `Retry-After`                             | `src/plugins/core/actas.test.js`                           |
| 7   | Redis caído → 503 < 300 ms; Redis colgado → 503 ≤ timeout + margen | `src/plugins/core/actas.test.js`                           |

**Infraestructura de los tests:**

- **Una base por archivo:** cada archivo usa su propia base de Redis, porque vitest los corre
  en paralelo.
- **Redis colgado sin `CLIENT PAUSE`:** el test usa un proxy TCP congelable. `CLIENT PAUSE`
  congela el servidor entero y rompía los demás tests que corren a la vez.
- **Sin Redis disponible:** si no hay `REDIS_URL` y Redis no responde en localhost, los tests
  de Persona 1 se omiten con aviso. En CI, `REDIS_URL` está definido y son obligatorios.

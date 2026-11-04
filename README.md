# Preconteo en tiempo real — Taller de WebSockets

Sistema de preconteo para una jornada electoral departamental: recibe las actas de 6.400 mesas
y las difunde, con garantías distintas, a jurados, auditores y hasta 400.000 navegadores.
Corre en 8 instancias de Node.js (Fastify) sin sesiones pegajosas, coordinadas solo por Redis.

> Estado actual: **esqueleto con contratos y stubs**. Todo arranca y responde, pero con
> implementaciones falsas marcadas con `// STUB` (avisan una vez en consola con `[STUB] ...`).

## Dueños de cada carpeta

| Persona                                | Área                                                             | Carpetas                                                                                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Persona 1** (`@persona1`)            | Infra + Redis core                                               | `infra/`, `src/server.js`, `src/config.js`, `src/redis/**`, `src/dominio/**`, `src/plugins/core/**`, `scripts/seed-catalogo.js`, `scripts/simular-actas.js`, `docs/persona1-redis.md` |
| **Persona 2** (`@persona2`)            | Tiempo real público + fan-out + métricas                         | `src/fanout/**`, `src/transport/**`, `src/metrics/**`, `src/plugins/tiempo-real/**`, `load-test/**`, `docs/persona2-fanout.md`                                                        |
| **Persona 3** (`@persona3`)            | Verificación + presencia + WS de jurados y auditores + frontends | `src/verificacion/**`, `src/presencia/**`, `src/plugins/verificacion/**`, `frontend/**`, `docs/persona3-verificacion.md`                                                              |
| **Compartido** (PR aprobado por los 3) | Contratos y configuración                                        | `src/contratos/**`, `docs/contratos.md`, `package.json`, `.github/**`, `test/**`, `scripts/emisor-falso.js`, `scripts/jurado-falso.js`                                                |

La misma tabla está en [`.github/CODEOWNERS`](.github/CODEOWNERS). Los contratos (claves de
Redis, canales, esquemas, firmas y endpoints) están explicados en
[`docs/contratos.md`](docs/contratos.md).

## Requisitos

Node.js 22, npm y Docker (Docker Desktop en Windows/macOS).

## Levantar en local

### Desarrollo (1 instancia)

```bash
npm install
cp .env.example .env          # opcional
npm run redis:dev             # Redis 7 en localhost:6379
npm run dev                   # http://localhost:3000, se reinicia al guardar
```

Sin Redis la app también arranca (`/salud` responde 503 `degradado`), útil para trabajar en stubs.

Herramientas para trabajar sin esperar a los demás:

```bash
npm run emisor:falso          # publica cada segundo un EventoActaNueva en acta:nueva y stream:actas
npm run jurado:falso          # envía actas a POST /actas con reenvíos, correcciones y dudosas
URL=http://localhost:8080 N=200 npm run jurado:falso   # contra el compose
```

### Compose completo (Redis + 8 réplicas + nginx)

```bash
npm run compose:up            # build + arranque; nginx en http://localhost:8080
npm run compose:down
```

Si el puerto 8080 está ocupado: `NGINX_PORT=8081 npm run compose:up` (en PowerShell:
`$env:NGINX_PORT=8081; npm run compose:up`).

### Comprobar que las peticiones caen en instancias distintas

nginx reparte en round-robin **sin** `ip_hash` ni sticky, así que peticiones seguidas deben
mostrar IDs distintos (el ID es el hostname del contenedor):

```bash
for i in $(seq 1 16); do curl -s http://localhost:8080/instancia; echo; done
# o solo el header:
for i in $(seq 1 16); do curl -si http://localhost:8080/instancia | grep -i x-instance-id; done
```

En PowerShell:

```powershell
1..16 | % { (Invoke-RestMethod http://localhost:8080/instancia).instancia }
```

## Scripts

| Script                                          | Qué hace                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `npm run dev`                                   | Servidor con recarga (`node --watch`), carga `.env` si existe                    |
| `npm start`                                     | Servidor en modo producción                                                      |
| `npm test`                                      | Tests (vitest). Con `REDIS_URL` definido también corre el test contra Redis real |
| `npm run lint` / `npm run format`               | ESLint / Prettier                                                                |
| `npm run emisor:falso` / `npm run jurado:falso` | Generadores de tráfico falso                                                     |
| `npm run redis:dev`                             | Solo Redis para desarrollo                                                       |
| `npm run compose:up` / `npm run compose:down`   | Entorno completo con 8 réplicas                                                  |

## Cómo se agregan rutas

`src/server.js` registra `app.redis`, `app.redisSub` y `@fastify/websocket`, y autocarga todo
`src/plugins/**`. **Nadie edita `server.js` para registrar rutas**: cada persona crea archivos en
su subcarpeta (`core/`, `tiempo-real/`, `verificacion/`). Detalles en
[`docs/contratos.md` §6](docs/contratos.md#6-cómo-agregar-rutas-sin-tocar-serverjs).

## Flujo de trabajo con Git

- `main` está **protegida**: no se hace push directo; todo entra por PR con CI en verde y la
  aprobación del dueño (CODEOWNERS). Configúrelo en GitHub → Settings → Branches → _Add rule_
  para `main`: _Require a pull request_, _Require review from Code Owners_, _Require status
  checks (CI)_.
- Ramas por persona: `persona1/idempotencia`, `persona2/fanout-lotes`, `persona3/lock-auditor`…
  Para contratos: `contrato/<descripcion>`.
- **PR pequeños** (un cambio coherente, idealmente < 400 líneas) y **rebase frecuente** sobre main:

  ```bash
  git fetch origin
  git rebase origin/main        # o: git pull --rebase origin main
  git push --force-with-lease
  ```

- Commits con Conventional Commits en español: `feat(fanout): enviar por lotes con setImmediate`.

> **Regla de oro:** reemplaza los stubs sin cambiar las firmas; si una firma debe cambiar,
> PR a `src/contratos` con los 3 de acuerdo.

## Estructura

```text
src/
  server.js             construirApp(): Fastify + Redis + autoload de src/plugins
  config.js             variables de entorno
  contratos/            COMPARTIDO: keys, canales, esquemas zod, interfaces, stream
  redis/  dominio/      Persona 1
  fanout/ transport/ metrics/   Persona 2
  verificacion/ presencia/      Persona 3
  plugins/
    core/               Persona 1: /instancia, /salud, /actas, /acumulado, /ranking
    tiempo-real/        Persona 2: /sse/publico, /metrics
    verificacion/       Persona 3: /ws/jurado, /ws/auditor
scripts/                emisor-falso, jurado-falso (compartidos), seed y simulación (P1)
infra/                  Dockerfile, docker-compose (8 réplicas), compose dev, nginx.conf
test/humo/              tests de humo compartidos
frontend/  load-test/   Persona 3 / Persona 2
docs/                   contratos y bitácora de cada persona
```

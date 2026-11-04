-- Dueño: Persona 1. Registro atómico de un acta (RF-1, RF-2, RF-3).
--
-- Todo lo que decide y escribe va en UN script: Redis ejecuta un script de principio a fin
-- sin intercalar comandos de otros clientes. Así, dos instancias que reciben el mismo
-- reintento a la vez no pueden aplicarlo dos veces, y ningún lector ve un municipio que ya
-- incluye un acta que su puesto todavía no muestra.
--
-- Restricciones que respetamos: (1) todas las claves llegan en KEYS (nada se construye aquí:
-- migrable a Cluster si todas comparten hash tag); (2) costo O(candidatos): sin bucles sobre
-- datos que crecen; (3) nada no determinista: recibo y ts los genera Node y llegan en ARGV.
--
-- KEYS: 1 acta:{id}  2 acta:{id}:versiones  3 idem:{k}
--       4 acum:mesa  5 acum:pue  6 acum:mun  7 acum:dep
--       8 rank:pue   9 rank:mun  10 rank:dep
--       11 stream:actas  12 cola:verificacion
-- ARGV: 1 modo ('registrar' | 'verificar')  2 id del acta  3 version  4 hash del contenido
--       5 datos JSON {votos, sufragantes, mesa, puesto, municipio, jurado}
--       6 cuadra ('1'|'0')  7 recibo  8 ts (ms)  9 TTL idem (s)  10 MAXLEN del stream
--       11 canal pub/sub  12 prioridad en la cola (si es dudosa)
-- Devuelve: JSON. En modo 'registrar', una RespuestaRegistro; en 'verificar',
--           {aplicada, stream_id?, motivo?, version_vigente?}.

local K_ACTA, K_VERS, K_IDEM = KEYS[1], KEYS[2], KEYS[3]
local K_ACUM = { KEYS[4], KEYS[5], KEYS[6], KEYS[7] }
local K_RANK = { KEYS[8], KEYS[9], KEYS[10] }
local K_STREAM, K_COLA = KEYS[11], KEYS[12]

local modo = ARGV[1]
local id = ARGV[2]
local version = tonumber(ARGV[3])
local hash = ARGV[4]
local recibo, ts = ARGV[7], ARGV[8]
local ttl_idem, maxlen, canal = tonumber(ARGV[9]), ARGV[10], ARGV[11]

local vigente = tonumber(redis.call('HGET', K_ACTA, 'version_aplicada') or '0')

-- Suma (signo = 1) o resta (signo = -1) unos votos en los 4 niveles y en los 3 rankings.
local function sumar(votos, sufragantes, signo, primera_vez)
  for _, k in ipairs(K_ACUM) do
    for c, v in pairs(votos) do
      redis.call('HINCRBY', k, c, signo * v)
    end
    redis.call('HINCRBY', k, 'sufragantes', signo * sufragantes)
    if primera_vez then
      redis.call('HINCRBY', k, 'informadas', 1)
    end
  end
  for _, k in ipairs(K_RANK) do
    for c, v in pairs(votos) do
      if string.match(c, '^C%d+$') then
        redis.call('ZINCRBY', k, signo * v, c)
      end
    end
  end
end

-- Revierte la versión aplicada (si hay), aplica la nueva, deja rastro en el stream y avisa.
local function aplicar(datos, recibo_aplicado)
  local primera_vez = vigente == 0
  if not primera_vez then
    local previos = cjson.decode(redis.call('HGET', K_ACTA, 'votos'))
    local suf_previos = tonumber(redis.call('HGET', K_ACTA, 'sufragantes'))
    sumar(previos, suf_previos, -1, false)
  end
  sumar(datos.votos, datos.sufragantes, 1, primera_vez)

  redis.call('HSET', K_ACTA,
    'version_aplicada', version, 'votos', cjson.encode(datos.votos),
    'sufragantes', datos.sufragantes, 'estado', 'aplicada', 'jurado', datos.jurado,
    'recibo', recibo_aplicado, 'ts', ts,
    'mesa', datos.mesa, 'pue', datos.puesto, 'mun', datos.municipio)

  -- Una dudosa pendiente que ya quedó superada por esta versión válida sale de la cola.
  local dudosa = tonumber(redis.call('HGET', K_ACTA, 'version_dudosa') or '0')
  if dudosa > 0 and dudosa <= version then
    redis.call('ZREM', K_COLA, id)
    redis.call('HDEL', K_ACTA, 'version_dudosa')
  end

  local tipo = primera_vez and 'nueva' or 'correccion'
  local evento = { acta = id, mun = datos.municipio, pue = datos.puesto, version = version, tipo = tipo }
  local stream_id = redis.call('XADD', K_STREAM, 'MAXLEN', '~', maxlen, '*', 'evento', cjson.encode(evento))
  evento.stream_id = stream_id
  redis.call('PUBLISH', canal, cjson.encode(evento))
  vigente = version
  return stream_id
end

local function respuesta(estado, extra)
  local r = { estado = estado, acta = id, version = version }
  if vigente > 0 then r.version_vigente = vigente end
  for k, v in pairs(extra or {}) do r[k] = v end
  return r
end

-- Un reenvío responde lo mismo que la primera vez, marcado como duplicada.
local function como_duplicada(original)
  local r = cjson.decode(original)
  r.motivo = 'reenvio de un acta ya recibida (estado original: ' .. r.estado .. ')'
  r.estado = 'duplicada'
  if vigente > 0 then r.version_vigente = vigente end
  return r
end

-- ───────────────────────────── modo verificar ─────────────────────────────
-- Un auditor aprobó la versión `version` (dudosa) del acta: se aplica su contenido guardado.
if modo == 'verificar' then
  local datos_json = redis.call('HGET', K_VERS, version .. ':datos')
  if not datos_json then
    return cjson.encode({ aplicada = false, motivo = 'version_no_dudosa_o_desconocida' })
  end
  if version <= vigente then
    redis.call('ZREM', K_COLA, id)
    redis.call('HDEL', K_ACTA, 'version_dudosa')
    return cjson.encode({ aplicada = false, motivo = 'version_obsoleta', version_vigente = vigente })
  end
  local original = cjson.decode(redis.call('HGET', K_VERS, version .. ':r'))
  local stream_id = aplicar(cjson.decode(datos_json), original.recibo)
  return cjson.encode({ aplicada = true, stream_id = stream_id, version_vigente = vigente })
end

-- ───────────────────────────── modo registrar ─────────────────────────────
-- 1) Camino rápido: la clave de idempotencia existe.
local previa = redis.call('GET', K_IDEM)
if previa then
  local p = cjson.decode(previa)
  if p.h ~= hash or p.r.acta ~= id or p.r.version ~= version then
    return cjson.encode(respuesta('conflicto', { motivo = 'idem reutilizado con otro contenido' }))
  end
  return cjson.encode(como_duplicada(cjson.encode(p.r)))
end

-- 2) Defensa de fondo: (acta, versión) ya registrada aunque idem haya expirado.
local hash_previo = redis.call('HGET', K_VERS, version)
if hash_previo then
  if hash_previo ~= hash then
    return cjson.encode(respuesta('conflicto', { motivo = 'misma version con contenido distinto' }))
  end
  local original = redis.call('HGET', K_VERS, version .. ':r')
  redis.call('SET', K_IDEM, cjson.encode({ r = cjson.decode(original), h = hash }), 'EX', ttl_idem)
  return cjson.encode(como_duplicada(original))
end

-- 3) Versión nueva.
local datos = cjson.decode(ARGV[5])
local r
if version < vigente then
  r = respuesta('version_obsoleta', { recibo = recibo })
elseif ARGV[6] == '1' then
  aplicar(datos, recibo)
  r = respuesta('registrada', { recibo = recibo })
else
  -- Dudosa: se guarda su contenido, no toca el acumulado y entra a la cola si es la mayor.
  redis.call('HSET', K_VERS, version .. ':datos', ARGV[5])
  local dudosa = tonumber(redis.call('HGET', K_ACTA, 'version_dudosa') or '0')
  if version > dudosa then
    redis.call('HSET', K_ACTA, 'version_dudosa', version)
    redis.call('ZADD', K_COLA, tonumber(ARGV[12]), id)
  end
  if vigente == 0 then
    redis.call('HSET', K_ACTA, 'estado', 'dudosa', 'version_aplicada', 0,
      'mesa', datos.mesa, 'pue', datos.puesto, 'mun', datos.municipio)
  end
  r = respuesta('dudosa', { recibo = recibo })
end

local r_json = cjson.encode(r)
redis.call('HSET', K_VERS, version, hash, version .. ':r', r_json)
redis.call('SET', K_IDEM, cjson.encode({ r = r, h = hash }), 'EX', ttl_idem)
return r_json

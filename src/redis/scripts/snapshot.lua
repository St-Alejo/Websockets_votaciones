#!lua flags=no-writes
-- Dueño: Persona 1. Lectura consistente de varios niveles + último stream_id (RF-3, RF-6).
--
-- Como registrar.lua escribe los 4 niveles y hace XADD en una sola ejecución, y este script
-- lee todo también en una sola ejecución, el resultado es una fotografía de un instante:
-- nunca un municipio que ya incluye un acta que su puesto todavía no muestra, y el
-- stream_id devuelto es exactamente el último evento incluido en la fotografía.
-- "no-writes": puede correr en una réplica de solo lectura.
--
-- KEYS: pares (acum:..., cat:...:mesas) por cada nivel pedido, y al final stream:actas.
-- Devuelve: { hgetall_1, total_1, hgetall_2, total_2, ..., ultimo_stream_id }

local n = #KEYS
local out = {}
for i = 1, n - 1, 2 do
  out[#out + 1] = redis.call('HGETALL', KEYS[i])
  out[#out + 1] = redis.call('GET', KEYS[i + 1]) or false
end
local ultimo = redis.call('XREVRANGE', KEYS[n], '+', '-', 'COUNT', 1)
out[#out + 1] = ultimo[1] and ultimo[1][1] or '0-0'
return out

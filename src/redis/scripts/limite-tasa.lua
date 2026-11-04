-- Dueño: Persona 1. Límite de tasa con ventana fija por jurado.
-- INCR + PEXPIRE en un solo script: si se hicieran por separado y la instancia muriera entre
-- ambos, el contador quedaría sin TTL y el jurado bloqueado para siempre.
-- KEYS: 1 rl:{jurado}:{ventana}   ARGV: 1 duración de la ventana (ms)
-- Devuelve: { contador, ms_restantes_de_la_ventana }
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { n, redis.call('PTTL', KEYS[1]) }

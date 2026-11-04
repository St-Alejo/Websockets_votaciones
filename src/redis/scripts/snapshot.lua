#!lua flags=no-writes
local n = #KEYS
local out = {}
for i = 1, n - 1, 2 do
  out[#out + 1] = redis.call('HGETALL', KEYS[i])
  out[#out + 1] = redis.call('GET', KEYS[i + 1]) or false
end
local last = redis.call('XREVRANGE', KEYS[n], '+', '-', 'COUNT', 1)
out[#out + 1] = last[1] and last[1][1] or '0-0'
return out

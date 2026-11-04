local K_TALLY, K_VERS, K_IDEM = KEYS[1], KEYS[2], KEYS[3]
local K_TOTAL = { KEYS[4], KEYS[5], KEYS[6], KEYS[7] }
local K_RANK = { KEYS[8], KEYS[9], KEYS[10] }
local K_STREAM, K_QUEUE = KEYS[11], KEYS[12]

local mode = ARGV[1]
local id = ARGV[2]
local version = tonumber(ARGV[3])
local hash = ARGV[4]
local receipt, ts = ARGV[7], ARGV[8]
local ttl_idem, maxlen, channel = tonumber(ARGV[9]), ARGV[10], ARGV[11]

local current = tonumber(redis.call('HGET', K_TALLY, 'applied_version') or '0')

local function add(votes, voters, sign, first_time)
  for _, k in ipairs(K_TOTAL) do
    for c, v in pairs(votes) do
      redis.call('HINCRBY', k, c, sign * v)
    end
    redis.call('HINCRBY', k, 'voters', sign * voters)
    if first_time then
      redis.call('HINCRBY', k, 'reported', 1)
    end
  end
  for _, k in ipairs(K_RANK) do
    for c, v in pairs(votes) do
      if string.match(c, '^C%d+$') then
        redis.call('ZINCRBY', k, sign * v, c)
      end
    end
  end
end

local function apply(data, applied_receipt)
  local first_time = current == 0
  if not first_time then
    local previous = cjson.decode(redis.call('HGET', K_TALLY, 'votes'))
    local previous_voters = tonumber(redis.call('HGET', K_TALLY, 'voters'))
    add(previous, previous_voters, -1, false)
  end
  add(data.votes, data.voters, 1, first_time)

  redis.call('HSET', K_TALLY,
    'applied_version', version, 'votes', cjson.encode(data.votes),
    'voters', data.voters, 'status', 'applied', 'juror', data.juror,
    'receipt', applied_receipt, 'ts', ts,
    'table', data.table, 'station', data.station, 'mun', data.municipality)

  local doubtful = tonumber(redis.call('HGET', K_TALLY, 'doubtful_version') or '0')
  if doubtful > 0 and doubtful <= version then
    redis.call('ZREM', K_QUEUE, id)
    redis.call('HDEL', K_TALLY, 'doubtful_version')
  end

  local type = first_time and 'new' or 'correction'
  local event = { tally = id, mun = data.municipality, station = data.station, version = version, type = type }
  local stream_id = redis.call('XADD', K_STREAM, 'MAXLEN', '~', maxlen, '*', 'event', cjson.encode(event))
  event.stream_id = stream_id
  redis.call('PUBLISH', channel, cjson.encode(event))
  current = version
  return stream_id
end

local function response(status, extra)
  local r = { status = status, tally = id, version = version }
  if current > 0 then r.current_version = current end
  for k, v in pairs(extra or {}) do r[k] = v end
  return r
end

local function as_duplicate(original)
  local r = cjson.decode(original)
  r.reason = 'resend of an already received tally (original status: ' .. r.status .. ')'
  r.status = 'duplicate'
  if current > 0 then r.current_version = current end
  return r
end

if mode == 'verify' then
  local data_json = redis.call('HGET', K_VERS, version .. ':data')
  if not data_json then
    return cjson.encode({ applied = false, reason = 'version_not_doubtful_or_unknown' })
  end
  if version <= current then
    redis.call('ZREM', K_QUEUE, id)
    redis.call('HDEL', K_TALLY, 'doubtful_version')
    return cjson.encode({ applied = false, reason = 'stale_version', current_version = current })
  end
  local original = cjson.decode(redis.call('HGET', K_VERS, version .. ':r'))
  local stream_id = apply(cjson.decode(data_json), original.receipt)
  return cjson.encode({ applied = true, stream_id = stream_id, current_version = current })
end

local previous_idem = redis.call('GET', K_IDEM)
if previous_idem then
  local p = cjson.decode(previous_idem)
  if p.h ~= hash or p.r.tally ~= id or p.r.version ~= version then
    return cjson.encode(response('conflict', { reason = 'idem reused with different content' }))
  end
  return cjson.encode(as_duplicate(cjson.encode(p.r)))
end

local previous_hash = redis.call('HGET', K_VERS, version)
if previous_hash then
  if previous_hash ~= hash then
    return cjson.encode(response('conflict', { reason = 'same version with different content' }))
  end
  local original = redis.call('HGET', K_VERS, version .. ':r')
  redis.call('SET', K_IDEM, cjson.encode({ r = cjson.decode(original), h = hash }), 'EX', ttl_idem)
  return cjson.encode(as_duplicate(original))
end

local data = cjson.decode(ARGV[5])
local r
if version < current then
  r = response('stale_version', { receipt = receipt })
elseif ARGV[6] == '1' then
  apply(data, receipt)
  r = response('registered', { receipt = receipt })
else
  redis.call('HSET', K_VERS, version .. ':data', ARGV[5])
  local doubtful = tonumber(redis.call('HGET', K_TALLY, 'doubtful_version') or '0')
  if version > doubtful then
    redis.call('HSET', K_TALLY, 'doubtful_version', version)
    redis.call('ZADD', K_QUEUE, tonumber(ARGV[12]), id)
  end
  if current == 0 then
    redis.call('HSET', K_TALLY, 'status', 'doubtful', 'applied_version', 0,
      'table', data.table, 'station', data.station, 'mun', data.municipality)
  end
  r = response('doubtful', { receipt = receipt })
end

local r_json = cjson.encode(r)
redis.call('HSET', K_VERS, version, hash, version .. ':r', r_json)
redis.call('SET', K_IDEM, cjson.encode({ r = r, h = hash }), 'EX', ttl_idem)
return r_json

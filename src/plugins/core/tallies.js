import { LEVELS } from '../../contracts/keys.js';
import { readTotals, ranking, registerTally } from '../../domain/index.js';

const HTTP_BY_STATUS = {
  registered: 201,
  duplicate: 200,
  stale_version: 200,
  doubtful: 202,
  conflict: 409,
  rejected: 400,
};

function validateLevel(req, reply) {
  const { level, id } = req.params;
  if (!LEVELS.includes(level) || (level !== 'dept' && !id)) {
    reply.code(400).send({ error: 'invalid_level', levels: LEVELS });
    return false;
  }
  return true;
}

export default async function tallies(app) {
  app.setErrorHandler((err, req, reply) => {
    if (err?.code === 'redis_unavailable') {
      req.log.warn({ msg: err.message }, 'redis unavailable');
      return reply
        .code(503)
        .header('Retry-After', '2')
        .send({
          status: 'not_registered',
          retry: true,
          reason:
            'Redis did not respond: the registration could not be confirmed. Retry with the same idem; ' +
            'the retry is safe (if the tally was registered, it will respond "duplicate").',
        });
    }
    if (err?.code === 'rate_limited') {
      return reply
        .code(429)
        .header('Retry-After', String(err.retryInS))
        .send({ error: 'rate_limited', juror: err.juror, retry_in_s: err.retryInS });
    }
    return reply.send(err);
  });

  app.post('/tallies', async (req, reply) => {
    const response = await registerTally(req.body);
    reply.code(HTTP_BY_STATUS[response.status] ?? 200);
    return response;
  });

  app.get('/totals/:level/:id?', async (req, reply) => {
    if (!validateLevel(req, reply)) return reply;
    const { level, id } = req.params;
    return readTotals(level, level === 'dept' ? null : id);
  });

  app.get('/ranking/:level/:id?', async (req, reply) => {
    if (!validateLevel(req, reply)) return reply;
    const { level, id } = req.params;
    const top = Math.min(Math.max(Number(req.query.top) || 10, 1), 100);
    return ranking(level, level === 'dept' ? null : id, top);
  });
}

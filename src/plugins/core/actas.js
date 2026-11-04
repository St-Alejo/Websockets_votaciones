// Dueño: Persona 1. POST /actas, GET /acumulado/:nivel/:id, GET /ranking/:nivel/:id.
import { NIVELES } from '../../contratos/keys.js';
import { leerAcumulado, ranking, registrarActa } from '../../dominio/index.js';

/** Código HTTP por estado de RespuestaRegistro (ver docs/contratos.md). */
const HTTP_POR_ESTADO = {
  registrada: 201,
  duplicada: 200,
  version_obsoleta: 200,
  dudosa: 202,
  conflicto: 409,
  rechazada: 400,
};

function validarNivel(req, reply) {
  const { nivel, id } = req.params;
  if (!NIVELES.includes(nivel) || (nivel !== 'dep' && !id)) {
    reply.code(400).send({ error: 'nivel_invalido', niveles: NIVELES });
    return false;
  }
  return true;
}

export default async function actas(app) {
  // RF-10: nunca un 200 silencioso ni una petición colgada. Si Redis no respondió, el jurado
  // recibe un 503 explícito en ≤ REDIS_COMMAND_TIMEOUT_MS; reintentar con el mismo idem es
  // seguro porque el registro es idempotente (si sí alcanzó a escribirse, verá "duplicada").
  // Errores reconocidos por err.codigo (ErrorRedisNoDisponible / ErrorLimiteTasa de dominio).
  app.setErrorHandler((err, req, reply) => {
    if (err?.codigo === 'redis_no_disponible') {
      req.log.warn({ msg: err.message }, 'redis no disponible');
      return reply
        .code(503)
        .header('Retry-After', '2')
        .send({
          estado: 'no_registrada',
          reintentar: true,
          motivo:
            'Redis no respondió: no se pudo confirmar el registro. Reintente con el mismo idem; ' +
            'el reintento es seguro (si el acta alcanzó a registrarse, responderá "duplicada").',
        });
    }
    if (err?.codigo === 'limite_tasa') {
      return reply
        .code(429)
        .header('Retry-After', String(err.reintentarEnS))
        .send({ error: 'limite_tasa', jurado: err.jurado, reintentar_en_s: err.reintentarEnS });
    }
    return reply.send(err);
  });

  app.post('/actas', async (req, reply) => {
    const respuesta = await registrarActa(req.body);
    reply.code(HTTP_POR_ESTADO[respuesta.estado] ?? 200);
    return respuesta;
  });

  app.get('/acumulado/:nivel/:id?', async (req, reply) => {
    if (!validarNivel(req, reply)) return reply;
    const { nivel, id } = req.params;
    return leerAcumulado(nivel, nivel === 'dep' ? null : id);
  });

  app.get('/ranking/:nivel/:id?', async (req, reply) => {
    if (!validarNivel(req, reply)) return reply;
    const { nivel, id } = req.params;
    const top = Math.min(Math.max(Number(req.query.top) || 10, 1), 100);
    return ranking(nivel, nivel === 'dep' ? null : id, top);
  });
}

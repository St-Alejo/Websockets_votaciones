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

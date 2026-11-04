// Dueño: Persona 2. GET /metrics (formato Prometheus).
import { estadisticas } from '../../fanout/index.js';
import { exponer } from '../../metrics/index.js';

export default async function metrics(app) {
  app.get('/metrics', async (_req, reply) => {
    reply.type('text/plain; version=0.0.4');
    return exponer({ instancia: app.instanceId, conexiones: estadisticas().suscripciones });
  });
}

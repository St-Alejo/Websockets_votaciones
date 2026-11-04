// Dueño: Persona 2. GET /sse/publico?topico=mun:11&ultimo_id=...
// STUB: envía un snapshot inicial y latidos. Aún no reenvía eventos del backplane,
// no recupera desde ultimo_id (RF-6) ni aplica contrapresión (RF-9).
import { parsearTopico } from '../../contratos/canales.js';
import { snapshot } from '../../dominio/index.js';
import { desuscribir, suscribir } from '../../fanout/index.js';

const LATIDO_MS = 15_000;

export default async function ssePublico(app) {
  app.get('/sse/publico', async (req, reply) => {
    const topico = req.query.topico ?? 'dep';
    try {
      parsearTopico(topico);
    } catch {
      return reply.code(400).send({ error: 'topico_invalido', ejemplo: 'mun:11' });
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const conexion = {
      enviar(evento, datos, id) {
        if (id) res.write(`id: ${id}\n`);
        res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`);
      },
    };
    suscribir(conexion, topico);

    const foto = await snapshot([topico]);
    conexion.enviar('snapshot', { ...foto, instancia: app.instanceId }, foto.stream_id);

    const latido = setInterval(() => res.write(': latido\n\n'), LATIDO_MS);
    req.raw.on('close', () => {
      clearInterval(latido);
      desuscribir(conexion, topico);
    });
  });
}

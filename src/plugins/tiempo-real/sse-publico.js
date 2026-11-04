// Dueño: Persona 2. GET /sse/publico?topico=mun:11&ultimo_id=...
import { parsearTopico } from '../../contratos/canales.js';
import {
  desuscribir,
  enlazarBackplane,
  revisarPresion,
  soltarRetenidos,
  suscribir,
} from '../../fanout/index.js';
import { decidirReanudacion, directivaRetry, leerCursor } from '../../transport/reconexion.js';
import { CABECERAS_SSE, crearConexionSse, iniciarLatido } from '../../transport/sse.js';

const LATIDO_MS = 15_000;

export default async function ssePublico(app) {
  await enlazarBackplane(app.redisSub);

  app.get('/sse/publico', async (req, reply) => {
    const topico = req.query.topico ?? 'dep';
    try {
      parsearTopico(topico);
    } catch {
      return reply.code(400).send({ error: 'topico_invalido', ejemplo: 'mun:11' });
    }

    const cursor = leerCursor(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, CABECERAS_SSE);
    res.write(`retry: ${directivaRetry()}\n\n`);

    const conexion = crearConexionSse(res, { topico });
    conexion.acepta = false;
    suscribir(conexion, topico);

    let cerrado = false;
    const detenerLatido = iniciarLatido(res, LATIDO_MS, {
      alLatido: () => revisarPresion(conexion),
    });
    const cerrar = () => {
      if (cerrado) return;
      cerrado = true;
      conexion.cerrada = true;
      detenerLatido();
      desuscribir(conexion, topico);
    };
    req.raw.on('close', cerrar);
    res.on('error', cerrar);

    try {
      const plan = await decidirReanudacion({ cursor, topico });
      if (res.destroyed || res.writableEnded) {
        cerrar();
        return;
      }
      if (plan.modo === 'snapshot') {
        const foto = { ...plan.snapshot, instancia: app.instanceId };
        conexion.vistoHasta = plan.snapshot.stream_id;
        conexion.enviar('snapshot', foto, plan.snapshot.stream_id);
      } else {
        conexion.vistoHasta = cursor;
        for (const ev of plan.eventos) {
          conexion.enviar(
            'delta',
            { topico, stream_id: ev.stream_id, eventos: [ev] },
            ev.stream_id,
          );
          conexion.vistoHasta = ev.stream_id;
        }
      }
      soltarRetenidos(conexion);
    } catch (err) {
      app.log.error({ err }, 'sse reanudacion');
      if (!res.writableEnded && !res.destroyed) {
        conexion.enviar('error', { motivo: 'reanudacion_fallida' });
        soltarRetenidos(conexion);
      }
    }
  });
}

// Dueño: Persona 3. WS /ws/auditor?auditor=AUD-7 — consola de verificación.
// STUB: no difunde a las demás consolas (falta suscribirse a los canales verificacion/presencia).
import { liberarCaso, tomarCaso, verCola } from '../../verificacion/index.js';
import { latido, presentes, salir } from '../../presencia/index.js';

export default async function wsAuditor(app) {
  // Los listeners se registran antes de cualquier await para no perder mensajes tempranos.
  app.get('/ws/auditor', { websocket: true }, (socket, req) => {
    const auditor = String(req.query.auditor ?? '');
    const enviar = (msg) => socket.send(JSON.stringify(msg));
    if (!auditor) {
      enviar({ tipo: 'error', motivo: 'falta_auditor' });
      return socket.close(4001, 'falta_auditor');
    }

    socket.on('message', async (crudo) => {
      let msg;
      try {
        msg = JSON.parse(crudo.toString());
      } catch {
        return enviar({ tipo: 'error', motivo: 'json_invalido' });
      }
      switch (msg?.tipo) {
        case 'latido':
          await latido(auditor, { instancia: app.instanceId, acta_actual: msg.acta ?? null });
          return enviar({ tipo: 'latido_ok' });
        case 'tomar':
          return enviar({ tipo: 'caso', caso: await tomarCaso(auditor) });
        case 'liberar':
          return enviar({
            tipo: 'liberado',
            acta: msg.acta,
            ok: await liberarCaso(auditor, msg.acta, msg.token),
          });
        default:
          return enviar({ tipo: 'error', motivo: 'tipo_desconocido' });
      }
    });

    socket.on('close', () => salir(auditor));

    (async () => {
      await latido(auditor, { instancia: app.instanceId });
      enviar({
        tipo: 'hola',
        instancia: app.instanceId,
        cola: await verCola(),
        presentes: await presentes(),
      });
    })().catch((err) => app.log.error({ err }, 'ws-auditor'));
  });
}

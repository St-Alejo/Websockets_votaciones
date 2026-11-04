// Dueño: Persona 3. WS /ws/jurado — los jurados envían actas y reciben RespuestaRegistro.
// STUB: protocolo mínimo (ver docs/contratos.md). Falta la cola offline del cliente (RT-6).
import { registrarActa } from '../../dominio/index.js';

export default async function wsJurado(app) {
  app.get('/ws/jurado', { websocket: true }, (socket) => {
    const enviar = (msg) => socket.send(JSON.stringify(msg));
    enviar({ tipo: 'hola', instancia: app.instanceId });

    socket.on('message', async (crudo) => {
      let msg;
      try {
        msg = JSON.parse(crudo.toString());
      } catch {
        return enviar({ tipo: 'error', motivo: 'json_invalido' });
      }
      if (msg?.tipo !== 'acta') return enviar({ tipo: 'error', motivo: 'tipo_desconocido' });
      enviar({ tipo: 'respuesta', respuesta: await registrarActa(msg.acta) });
    });
  });
}

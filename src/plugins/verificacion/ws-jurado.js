// Dueño: Persona 3. WS /ws/jurado — los jurados envían actas y reciben RespuestaRegistro.
// RT-5: transporte bidireccional de jurados (el público usa SSE, ver P2).
// RT-6: el reintento offline vive en el cliente (frontend/jurado offlineQueue);
// aquí solo se garantiza: validar todo, ACK únicamente tras `registrarActa`
// (nunca confirmación falsa) e idempotencia delegada al dominio (P1, clave idem).
//
// Identidad: no hay infraestructura de auth en el repo (pendiente P1). El jurado
// se identifica con `?jurado=JUR-1` o `{tipo:'hola', jurado}` y TODAS sus actas
// deben traer ese mismo `jurado` (anti-suplantación). Sin identificar, se usa el
// `jurado` del acta validada.

import { ActaEntrante } from '../../contratos/esquemas.js';
import { registrarActa } from '../../dominio/index.js';
import { registrarClientes } from '../../redis/cliente.js';

/** Las actas pesan ~0,5 KB; 64 KB deja margen y frena abusos. */
export const MAX_MENSAJE_BYTES = 64 * 1024;

export default async function wsJurado(app) {
  // Las fachadas de dominio resuelven Redis vía obtenerRedis(). Se re-sincroniza
  // aquí desde app (fuente inyectable en tests) para que el registro valga en la
  // instancia del módulo que carga este plugin. En producción es el mismo objeto.
  registrarClientes({ redis: app.redis, redisSub: app.redisSub });

  app.get('/ws/jurado', { websocket: true }, (socket, req) => {
    let jurado =
      typeof req.query.jurado === 'string' && req.query.jurado.trim() !== ''
        ? req.query.jurado.trim()
        : null;

    const enviar = (msg) => {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        /* socket ya cerrado */
      }
    };
    enviar({ tipo: 'hola', instancia: app.instanceId });

    socket.on('message', async (crudo) => {
      const texto = crudo.toString();
      if (texto.length > MAX_MENSAJE_BYTES) {
        enviar({ tipo: 'error', motivo: 'mensaje_muy_grande', maximo_bytes: MAX_MENSAJE_BYTES });
        try {
          socket.close(1009, 'mensaje_muy_grande');
        } catch {
          /* ya cerrado */
        }
        return;
      }
      let msg;
      try {
        msg = JSON.parse(texto);
      } catch {
        return enviar({ tipo: 'error', motivo: 'json_invalido' });
      }
      if (!msg || typeof msg.tipo !== 'string') {
        return enviar({ tipo: 'error', motivo: 'tipo_desconocido' });
      }

      switch (msg.tipo) {
        case 'hola': {
          if (typeof msg.jurado === 'string' && msg.jurado.trim() !== '') {
            jurado = msg.jurado.trim();
          }
          if (!jurado) return enviar({ tipo: 'error', motivo: 'falta_jurado' });
          return enviar({ tipo: 'hola', instancia: app.instanceId, jurado });
        }
        case 'acta': {
          const r = ActaEntrante.safeParse(msg.acta);
          if (!r.success) {
            return enviar({
              tipo: 'error',
              motivo: 'acta_invalida',
              detalles: r.error.issues
                .slice(0, 5)
                .map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`)
                .join('; '),
            });
          }
          if (jurado && r.data.jurado !== jurado) {
            return enviar({ tipo: 'error', motivo: 'jurado_no_coincide' });
          }
          let respuesta;
          try {
            // ACK real: solo se confirma lo que el dominio resolvió (registrarActa
            // nunca lanza por datos inválidos; sí puede lanzar si Redis falla).
            respuesta = await registrarActa(r.data);
          } catch (err) {
            app.log.error({ err }, 'ws-jurado: registrarActa falló');
            return enviar({ tipo: 'error', motivo: 'registro_fallido' });
          }
          return enviar({ tipo: 'respuesta', respuesta });
        }
        default:
          return enviar({ tipo: 'error', motivo: 'tipo_desconocido' });
      }
    });
  });
}

// Dueño: Persona 3. WS /ws/auditor?auditor=AUD-7 — consola colaborativa (RF-7, RF-8).
// RT-5: los auditores usan WebSocket bidireccional (el público usa SSE, ver P2).
//
// Reglas:
// - La identidad sale SIEMPRE del query `?auditor=` validado (nunca de un campo
//   del mensaje: evita suplantación). Formato: [A-Za-z0-9_-]{1,64}. No hay JWT en
//   el repo (pendiente coordinar con P1); esto es identificación, no auth fuerte.
// - Un auditor sostiene UN caso a la vez (si pide otro sin liberar: ya_tienes_caso).
// - La fuente de verdad es Redis: el bloqueo decide (tomarCaso hace SET NX).
//   El frontend nunca asigna por su cuenta.
// - Al tomar se inicia heartbeat servidor (renueva el lock); al liberar/completar
//   o al cerrar limpio se detiene. Al cerrar NO se libera el bloqueo: expira solo
//   (permite reconexión con el mismo token y evita carreras con otra instancia).
// - Difusión entre las 8 instancias vía Pub/Sub (`verificacion`, `presencia`):
//   cada instancia reemite a SUS sockets. Sin Redis, cada instancia solo ve lo suyo.

import { CANALES } from '../../contratos/canales.js';
import { actualizarActa, latido, presentes, salir } from '../../presencia/index.js';
import { registrarClientes } from '../../redis/cliente.js';
import { detenerHeartbeat, iniciarHeartbeat } from '../../verificacion/heartbeat.js';
import { liberarCaso, resolverCaso, tomarCaso, verCola } from '../../verificacion/index.js';

export const MAX_MENSAJE_BYTES = 64 * 1024;
const ID_AUDITOR = /^[A-Za-z0-9_-]{1,64}$/;

/** Envía a todos los sockets auditor de ESTA instancia. */
function difundir(app, msg) {
  const texto = JSON.stringify(msg);
  for (const s of app.auditoresWs ?? []) {
    try {
      if (s.readyState === 1) s.send(texto);
    } catch {
      /* socket muerto; el 'close' lo saca del set */
    }
  }
}

/** Suscripción única por instancia a los canales compartidos. */
async function suscribirBackplane(app) {
  if (app._p3backplane) return;
  app._p3backplane = true;
  const sub = app.redisSub;
  if (!sub || typeof sub.subscribe !== 'function') {
    app.log.warn('ws-auditor: sin redisSub, sin difusión entre instancias (modo degradado)');
    return;
  }
  try {
    await sub.subscribe(CANALES.VERIFICACION, CANALES.PRESENCIA);
  } catch (err) {
    app.log.warn({ err }, 'ws-auditor: no se pudo suscribir al backplane');
    return;
  }
  if (typeof sub.on === 'function') {
    sub.on('message', async (canal, texto) => {
      try {
        const evento = JSON.parse(texto);
        if (canal === CANALES.VERIFICACION) {
          const cola = await verCola().catch(() => null);
          if (cola) difundir(app, { tipo: 'cola', cola, evento });
        } else if (canal === CANALES.PRESENCIA) {
          const lista = await presentes().catch(() => null);
          if (lista) difundir(app, { tipo: 'presentes', presentes: lista, evento });
        }
      } catch (err) {
        app.log.warn({ err }, 'ws-auditor: evento de backplane inválido');
      }
    });
  }
}

export default async function wsAuditor(app) {
  // Las fachadas (verificacion/presencia) resuelven Redis vía obtenerRedis().
  // Se re-sincroniza aquí desde app (fuente inyectable en tests) para que el
  // registro valga en la instancia del módulo que carga este plugin.
  // En producción es el mismo objeto: operación inocua.
  registrarClientes({ redis: app.redis, redisSub: app.redisSub });
  app.auditoresWs = new Set();
  // Sin await: con Redis caído el SUBSCRIBE queda en la cola offline y bloquearía el
  // arranque de la réplica (RF-10). Se completa solo cuando Redis vuelve.
  suscribirBackplane(app).catch((err) =>
    app.log.warn({ msg: err.message }, 'no se pudo suscribir al backplane de auditores'),
  );

  // Los listeners se registran antes de cualquier await para no perder mensajes tempranos.
  app.get('/ws/auditor', { websocket: true }, (socket, req) => {
    const auditor = String(req.query.auditor ?? '').trim();
    const enviar = (msg) => {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        /* socket ya cerrado */
      }
    };
    if (!ID_AUDITOR.test(auditor)) {
      enviar({ tipo: 'error', motivo: 'falta_auditor' });
      try {
        socket.close(4001, 'falta_auditor');
      } catch {
        /* ya cerrado */
      }
      return;
    }
    app.auditoresWs.add(socket);

    let actaActual = null;
    let tokenActual = null;
    let hb = null;

    const soltarCasoLocal = () => {
      if (hb) {
        try {
          hb.detener();
        } catch {
          /* ya detenido */
        }
        hb = null;
      } else if (actaActual && tokenActual) {
        try {
          detenerHeartbeat(actaActual, tokenActual);
        } catch {
          /* sin heartbeat activo */
        }
      }
      actaActual = null;
      tokenActual = null;
    };

    socket.on('message', async (crudo) => {
      const texto = crudo.toString();
      if (texto.length > MAX_MENSAJE_BYTES) {
        enviar({ tipo: 'error', motivo: 'mensaje_muy_grande' });
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

      try {
        switch (msg.tipo) {
          case 'latido': {
            const acta = typeof msg.acta === 'string' ? msg.acta : (actaActual ?? null);
            await latido(auditor, { instancia: app.instanceId, acta_actual: acta });
            return enviar({ tipo: 'latido_ok' });
          }
          case 'tomar': {
            if (tokenActual) {
              return enviar({ tipo: 'error', motivo: 'ya_tienes_caso', acta: actaActual });
            }
            const caso = await tomarCaso(auditor);
            if (!caso) return enviar({ tipo: 'caso', caso: null });
            actaActual = caso.acta;
            tokenActual = caso.token;
            await actualizarActa(auditor, actaActual).catch(() => null);
            hb = iniciarHeartbeat(actaActual, tokenActual, {
              redis: app.redis,
              onPerdido: () => {
                enviar({ tipo: 'bloqueo_perdido', acta: actaActual });
                soltarCasoLocal();
                actualizarActa(auditor, null).catch(() => null);
              },
            });
            return enviar({ tipo: 'caso', caso });
          }
          case 'liberar': {
            if (typeof msg.acta !== 'string' || typeof msg.token !== 'string') {
              return enviar({ tipo: 'error', motivo: 'peticion_invalida' });
            }
            const ok = await liberarCaso(auditor, msg.acta, msg.token);
            if (ok && msg.acta === actaActual) {
              soltarCasoLocal();
              await actualizarActa(auditor, null).catch(() => null);
            }
            return enviar({ tipo: 'liberado', acta: msg.acta, ok });
          }
          case 'completar': {
            if (typeof msg.acta !== 'string' || typeof msg.token !== 'string') {
              return enviar({ tipo: 'error', motivo: 'peticion_invalida' });
            }
            // Retira de la cola + libera el bloqueo + publica `resuelta`.
            // La aplicación del veredicto al acumulado (aplicarActaVerificada)
            // queda pendiente de que P1 exponga el payload dudoso completo.
            const ok = await resolverCaso(auditor, msg.acta, msg.token);
            if (ok && msg.acta === actaActual) {
              soltarCasoLocal();
              await actualizarActa(auditor, null).catch(() => null);
            }
            return enviar({ tipo: 'completado', acta: msg.acta, ok });
          }
          case 'cola':
            return enviar({ tipo: 'cola', cola: await verCola() });
          case 'presentes':
            return enviar({ tipo: 'presentes', presentes: await presentes() });
          default:
            return enviar({ tipo: 'error', motivo: 'tipo_desconocido' });
        }
      } catch (err) {
        app.log.error({ err, auditor }, 'ws-auditor: operación falló');
        return enviar({ tipo: 'error', motivo: 'operacion_fallida' });
      }
    });

    socket.on('close', () => {
      app.auditoresWs.delete(socket);
      // El bloqueo NO se libera aquí: expira solo (reconexión posible con el token).
      soltarCasoLocal();
      salir(auditor).catch((err) => app.log.warn({ err }, 'ws-auditor: salir falló'));
    });

    (async () => {
      await latido(auditor, { instancia: app.instanceId });
      enviar({
        tipo: 'hola',
        instancia: app.instanceId,
        cola: await verCola().catch(() => []),
        presentes: await presentes().catch(() => []),
      });
    })().catch((err) => app.log.error({ err }, 'ws-auditor'));
  });
}

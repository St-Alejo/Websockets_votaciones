// Dueño: Persona 2. Transporte SSE de la audiencia pública (RF-5, RT-5).
// El objeto `conexion` es opaco para el fan-out: sabe escribir un evento,
// cuántos bytes lleva pendientes (RF-9) y cómo cerrar el socket.
import { randomUUID } from 'node:crypto';

export const CABECERAS_SSE = Object.freeze({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  // El frontend público puede servirse desde otro dominio (Vercel): EventSource necesita CORS.
  'Access-Control-Allow-Origin': '*',
});

/** Cuántos latidos seguidos sin `drain` se toleran antes de dar el socket por colgado. */
const PINGS_SIN_DRENAR = 3;

export function escribirEvento(res, { evento, datos, id } = {}) {
  if (!res || res.writableEnded || res.destroyed) return false;
  let bloque = '';
  if (id != null && id !== '') bloque += `id: ${String(id).replace(/[\r\n]/g, '')}\n`;
  if (evento) bloque += `event: ${String(evento).replace(/[\r\n]/g, '')}\n`;
  const cuerpo = typeof datos === 'string' ? datos : JSON.stringify(datos ?? {});
  for (const linea of String(cuerpo).split('\n')) bloque += `data: ${linea}\n`;
  bloque += '\n';
  return res.write(bloque);
}

export function crearConexionSse(res, meta = {}) {
  const conexion = {
    id: meta.id ?? randomUUID(),
    topico: meta.topico ?? null,
    res,
    necesitaSnapshot: false,
    acepta: true,
    retenido: [],
    vistoHasta: null,
    enviar(evento, datos, id) {
      return escribirEvento(res, { evento, datos, id });
    },
    cerrar(motivo = 'cerrada') {
      if (res.writableEnded || res.destroyed) return;
      escribirEvento(res, { evento: 'cerrar', datos: { motivo } });
      res.end();
    },
    get bufferedAmount() {
      const socket = res.socket;
      if (socket && typeof socket.bufferedAmount === 'number') return socket.bufferedAmount;
      if (typeof res.writableLength === 'number') return res.writableLength;
      if (socket && typeof socket.writableLength === 'number') return socket.writableLength;
      return 0;
    },
  };
  return conexion;
}

/**
 * Comentario SSE periódico (`: ping`). Si el socket ya murió, o acumula
 * varios pings sin drenar, se destruye para no dejar fds colgados.
 * @param {import('node:http').ServerResponse} res
 * @param {number} [intervaloMs]
 * @param {{ alLatido?: () => void, alColgar?: () => void } | (() => void)} [opciones]
 * @returns {() => void} detiene el latido sin cerrar el socket
 */
export function iniciarLatido(res, intervaloMs = 15_000, opciones = {}) {
  const alColgar = typeof opciones === 'function' ? opciones : opciones.alColgar;
  const alLatido = typeof opciones === 'function' ? undefined : opciones.alLatido;
  const cada = intervaloMs ?? 15_000;
  let timer = null;
  let sinDrenar = 0;
  let detenido = false;

  const detener = () => {
    if (detenido) return;
    detenido = true;
    if (timer != null) clearInterval(timer);
    res.socket?.removeListener?.('drain', alDrenar);
  };

  const colgar = () => {
    detener();
    try {
      res.destroy?.();
    } catch {
      /* ya cerrado */
    }
    try {
      alColgar?.();
    } catch {
      /* el cleanup del caller no puede romper el intervalo */
    }
  };

  function alDrenar() {
    sinDrenar = 0;
  }
  res.socket?.on?.('drain', alDrenar);

  timer = setInterval(() => {
    if (detenido) return;
    if (res.destroyed || res.writableEnded || res.closed || res.socket?.destroyed) {
      colgar();
      return;
    }
    try {
      const ok = res.write(': ping\n\n');
      if (ok === false) {
        sinDrenar += 1;
        if (sinDrenar >= PINGS_SIN_DRENAR) {
          colgar();
          return;
        }
      } else {
        sinDrenar = 0;
      }
      alLatido?.();
    } catch {
      colgar();
    }
  }, cada);
  timer.unref?.();
  return detener;
}

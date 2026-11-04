// Cliente WS del jurado: stop-and-wait (un acta en vuelo) para correlación
// exacta respuesta→envío, más reconexión con backoff + jitter.
import { API_WS } from '../../config.js';
export function crearClienteJurado({ onEstado, onRespuestaInesperada } = {}) {
  let socket = null;
  let manual = false;
  let intento = 0;
  let url = null;
  let pendiente = null; // { resolver, rechazar, temporizador, acta }
  const TIMEOUT_MS = 15_000;

  const demora = () => Math.min(30_000, 1000 * 2 ** intento) + Math.random() * 500;

  function conectar(nuevaUrl) {
    if (nuevaUrl) url = nuevaUrl;
    manual = false;
    abrir();
  }

  function abrir() {
    onEstado?.('conectando');
    try {
      socket = new WebSocket(url);
    } catch {
      reintentar();
      return;
    }
    socket.onopen = () => {
      intento = 0;
      onEstado?.('conectada');
    };
    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.tipo === 'respuesta' && pendiente) {
        const p = pendiente;
        pendiente = null;
        clearTimeout(p.temporizador);
        // Verificación mínima: la respuesta debe ser del acta en vuelo.
        if (msg.respuesta?.acta && msg.respuesta.acta !== p.acta) {
          p.rechazar(new Error(`respuesta de otra acta (${msg.respuesta.acta})`));
        } else {
          p.resolver(msg.respuesta);
        }
      } else if (msg.tipo === 'error' && pendiente) {
        const p = pendiente;
        pendiente = null;
        clearTimeout(p.temporizador);
        p.rechazar(new Error(msg.motivo ?? 'error del servidor'));
      } else if (msg.tipo === 'respuesta' || msg.tipo === 'error') {
        onRespuestaInesperada?.(msg);
      }
    };
    socket.onerror = () => onEstado?.('conectando');
    socket.onclose = () => {
      if (pendiente) {
        const p = pendiente;
        pendiente = null;
        clearTimeout(p.temporizador);
        p.rechazar(new Error('conexión cerrada antes del ACK'));
      }
      onEstado?.('desconectada');
      if (!manual) reintentar();
    };
  }

  function reintentar() {
    const ms = demora();
    intento += 1;
    setTimeout(() => {
      if (!manual) abrir();
    }, ms);
  }

  function conectado() {
    return !!socket && socket.readyState === WebSocket.OPEN && !pendiente;
  }

  /** Envía un acta y resuelve SOLO con el ACK real del servidor. */
  function enviarActa(acta) {
    return new Promise((resolver, rechazar) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        rechazar(new Error('sin conexión'));
        return;
      }
      if (pendiente) {
        rechazar(new Error('ya hay un envío en vuelo'));
        return;
      }
      const temporizador = setTimeout(() => {
        if (pendiente) {
          pendiente = null;
          rechazar(new Error('timeout esperando ACK'));
        }
      }, TIMEOUT_MS);
      pendiente = { resolver, rechazar, temporizador, acta: acta.acta };
      socket.send(JSON.stringify({ tipo: 'acta', acta }));
    });
  }

  function cerrar() {
    manual = true;
    try {
      socket?.close(1000, 'salida');
    } catch {
      /* ya cerrado */
    }
  }

  return { conectar, enviarActa, conectado, cerrar };
}

export function urlPorDefecto(jurado) {
  return `${API_WS}/ws/jurado${jurado ? `?jurado=${encodeURIComponent(jurado)}` : ''}`;
}

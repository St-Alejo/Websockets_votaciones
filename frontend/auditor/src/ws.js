// Cliente WS del auditor con reconexión (backoff exponencial + jitter)
// y latido periódico. El servidor confirma cada asignación; aquí nunca
// se decide disponibilidad.
export function crearClienteWS({ obtenerActaActual, onAbierto, onMensaje, onEstado }) {
  let socket = null;
  let manual = false;
  let intento = 0;
  let latidoTimer = null;
  let url = null;

  const demora = () => {
    const base = Math.min(30_000, 1000 * 2 ** intento);
    return base + Math.random() * 500;
  };

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
      clearInterval(latidoTimer);
      // Latido de presencia cada 15 s (TTL del servidor: 45 s).
      latidoTimer = setInterval(() => {
        enviar({ tipo: 'latido', acta: obtenerActaActual?.() ?? null });
      }, 15_000);
      onAbierto?.();
    };
    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      onMensaje?.(msg);
    };
    socket.onerror = () => onEstado?.('conectando');
    socket.onclose = () => {
      clearInterval(latidoTimer);
      onEstado?.('desconectada');
      if (!manual) reintentar();
    };
  }

  function reintentar() {
    const ms = demora();
    intento += 1;
    onEstado?.(`reintentando en ${Math.round(ms / 1000)}s`);
    setTimeout(() => {
      if (!manual) abrir();
    }, ms);
  }

  function enviar(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function cerrar() {
    manual = true;
    clearInterval(latidoTimer);
    try {
      socket?.close(1000, 'salida');
    } catch {
      /* ya cerrado */
    }
  }

  return { conectar, enviar, cerrar };
}

// URL por defecto: mismo origen (funciona detrás de nginx que proxea /ws/).
export function urlPorDefecto(auditor) {
  const protocolo = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocolo}//${location.host}/ws/auditor?auditor=${encodeURIComponent(auditor)}`;
}

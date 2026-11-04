import { API_WS } from '../../config.js';
export function createWsClient({ getCurrentTally, onOpen, onMessage, onStatus }) {
  let socket = null;
  let manual = false;
  let attempt = 0;
  let heartbeatTimer = null;
  let url = null;

  const delay = () => {
    const base = Math.min(30_000, 1000 * 2 ** attempt);
    return base + Math.random() * 500;
  };

  function connect(newUrl) {
    if (newUrl) url = newUrl;
    manual = false;
    open();
  }

  function open() {
    onStatus?.('connecting');
    try {
      socket = new WebSocket(url);
    } catch {
      retry();
      return;
    }
    socket.onopen = () => {
      attempt = 0;
      onStatus?.('connected');
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        send({ type: 'heartbeat', tally: getCurrentTally?.() ?? null });
      }, 15_000);
      onOpen?.();
    };
    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      onMessage?.(msg);
    };
    socket.onerror = () => onStatus?.('connecting');
    socket.onclose = () => {
      clearInterval(heartbeatTimer);
      onStatus?.('disconnected');
      if (!manual) retry();
    };
  }

  function retry() {
    const ms = delay();
    attempt += 1;
    onStatus?.(`retrying in ${Math.round(ms / 1000)}s`);
    setTimeout(() => {
      if (!manual) open();
    }, ms);
  }

  function send(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function close() {
    manual = true;
    clearInterval(heartbeatTimer);
    try {
      socket?.close(1000, 'exit');
    } catch {
      return;
    }
  }

  return { connect, send, close };
}

export function defaultUrl(auditor) {
  return `${API_WS}/ws/auditor?auditor=${encodeURIComponent(auditor)}`;
}

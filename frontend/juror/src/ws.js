import { API_WS } from '../../config.js';
export function createJurorClient({ onStatus, onUnexpectedResponse } = {}) {
  let socket = null;
  let manual = false;
  let attempt = 0;
  let url = null;
  let pending = null;
  const TIMEOUT_MS = 15_000;

  const delay = () => Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;

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
    };
    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'response' && pending) {
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        if (msg.response?.tally && msg.response.tally !== p.tally) {
          p.reject(new Error(`response for another tally (${msg.response.tally})`));
        } else {
          p.resolve(msg.response);
        }
      } else if (msg.type === 'error' && pending) {
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        p.reject(new Error(msg.reason ?? 'server error'));
      } else if (msg.type === 'response' || msg.type === 'error') {
        onUnexpectedResponse?.(msg);
      }
    };
    socket.onerror = () => onStatus?.('connecting');
    socket.onclose = () => {
      if (pending) {
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        p.reject(new Error('connection closed before ACK'));
      }
      onStatus?.('disconnected');
      if (!manual) retry();
    };
  }

  function retry() {
    const ms = delay();
    attempt += 1;
    setTimeout(() => {
      if (!manual) open();
    }, ms);
  }

  function connected() {
    return !!socket && socket.readyState === WebSocket.OPEN && !pending;
  }

  function sendTally(tally) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('no connection'));
        return;
      }
      if (pending) {
        reject(new Error('a submission is already in flight'));
        return;
      }
      const timer = setTimeout(() => {
        if (pending) {
          pending = null;
          reject(new Error('timeout waiting for ACK'));
        }
      }, TIMEOUT_MS);
      pending = { resolve, reject, timer, tally: tally.tally };
      socket.send(JSON.stringify({ type: 'tally', tally }));
    });
  }

  function close() {
    manual = true;
    try {
      socket?.close(1000, 'exit');
    } catch {
      return;
    }
  }

  return { connect, sendTally, connected, close };
}

export function defaultUrl(juror) {
  return `${API_WS}/ws/juror${juror ? `?juror=${encodeURIComponent(juror)}` : ''}`;
}

import { randomUUID } from 'node:crypto';

export const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'Access-Control-Allow-Origin': '*',
});

const UNDRAINED_PINGS = 3;

function safely(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

export function writeEvent(res, { event, data, id } = {}) {
  if (!res || res.writableEnded || res.destroyed) return false;
  let block = '';
  if (id != null && id !== '') block += `id: ${String(id).replace(/[\r\n]/g, '')}\n`;
  if (event) block += `event: ${String(event).replace(/[\r\n]/g, '')}\n`;
  const body = typeof data === 'string' ? data : JSON.stringify(data ?? {});
  for (const line of String(body).split('\n')) block += `data: ${line}\n`;
  block += '\n';
  return res.write(block);
}

export function createSseConnection(res, meta = {}) {
  const connection = {
    id: meta.id ?? randomUUID(),
    topic: meta.topic ?? null,
    res,
    needsSnapshot: false,
    accepts: true,
    held: [],
    seenUntil: null,
    send(event, data, id) {
      return writeEvent(res, { event, data, id });
    },
    close(reason = 'closed') {
      if (res.writableEnded || res.destroyed) return;
      writeEvent(res, { event: 'close', data: { reason } });
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
  return connection;
}

export function startHeartbeat(res, intervalMs = 15_000, options = {}) {
  const onHang = typeof options === 'function' ? options : options.onHang;
  const onHeartbeat = typeof options === 'function' ? undefined : options.onHeartbeat;
  const every = intervalMs ?? 15_000;
  let timer = null;
  let undrained = 0;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer != null) clearInterval(timer);
    res.socket?.removeListener?.('drain', onDrain);
  };

  const hang = () => {
    stop();
    safely(() => res.destroy?.());
    safely(() => onHang?.());
  };

  function onDrain() {
    undrained = 0;
  }
  res.socket?.on?.('drain', onDrain);

  timer = setInterval(() => {
    if (stopped) return;
    if (res.destroyed || res.writableEnded || res.closed || res.socket?.destroyed) {
      hang();
      return;
    }
    try {
      const ok = res.write(': ping\n\n');
      if (ok === false) {
        undrained += 1;
        if (undrained >= UNDRAINED_PINGS) {
          hang();
          return;
        }
      } else {
        undrained = 0;
      }
      onHeartbeat?.();
    } catch {
      hang();
    }
  }, every);
  timer.unref?.();
  return stop;
}

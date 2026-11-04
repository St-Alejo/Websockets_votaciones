export const SUSPEND_THRESHOLD = 64 * 1024;

export const DISCONNECT_THRESHOLD = 512 * 1024;

export function readPending(connection) {
  if (!connection || typeof connection !== 'object') return 0;
  if (typeof connection.bufferedAmount === 'number' && Number.isFinite(connection.bufferedAmount)) {
    return connection.bufferedAmount;
  }
  const socket = connection.socket ?? connection.res?.socket;
  if (socket && typeof socket.bufferedAmount === 'number') return socket.bufferedAmount;
  if (typeof connection.writableLength === 'number') return connection.writableLength;
  if (socket && typeof socket.writableLength === 'number') return socket.writableLength;
  if (typeof connection.res?.writableLength === 'number') return connection.res.writableLength;
  return 0;
}

export function evaluate(connection, thresholds = {}) {
  const pending = readPending(connection);
  const suspend = thresholds.suspend ?? SUSPEND_THRESHOLD;
  const disconnect = thresholds.disconnect ?? DISCONNECT_THRESHOLD;
  if (pending >= disconnect) return { action: 'disconnect', pending };
  if (pending >= suspend) return { action: 'suspend', pending };
  if (connection?.needsSnapshot) return { action: 'snapshot', pending };
  return { action: 'delta', pending };
}

// Dueño: Persona 2. Contrapresión por cliente (RF-9).
// Si el buffer de salida supera el umbral, se suspenden los deltas y la conexión
// queda marcada para recibir un snapshot completo cuando el buffer baje.
// Si el cliente es extremadamente lento, se desconecta.

/** A partir de aquí se dejan de mandar deltas. */
export const UMBRAL_SUSPENDER = 64 * 1024;

/** A partir de aquí el cliente se considera irrecuperable y se cierra. */
export const UMBRAL_DESCONECTAR = 512 * 1024;

/**
 * Bytes pendientes de salir hacia el cliente.
 * Acepta `bufferedAmount` (WebSocket / navegador) o el buffer del socket HTTP.
 */
export function leerPendiente(conexion) {
  if (!conexion || typeof conexion !== 'object') return 0;
  if (typeof conexion.bufferedAmount === 'number' && Number.isFinite(conexion.bufferedAmount)) {
    return conexion.bufferedAmount;
  }
  const socket = conexion.socket ?? conexion.res?.socket;
  if (socket && typeof socket.bufferedAmount === 'number') return socket.bufferedAmount;
  if (typeof conexion.writableLength === 'number') return conexion.writableLength;
  if (socket && typeof socket.writableLength === 'number') return socket.writableLength;
  if (typeof conexion.res?.writableLength === 'number') return conexion.res.writableLength;
  return 0;
}

/**
 * Política pura: no escribe ni cierra. El motor aplica la acción.
 * @returns {{ accion: 'delta'|'suspender'|'snapshot'|'desconectar', pendiente: number }}
 */
export function evaluar(conexion, umbrales = {}) {
  const pendiente = leerPendiente(conexion);
  const suspender = umbrales.suspender ?? UMBRAL_SUSPENDER;
  const desconectar = umbrales.desconectar ?? UMBRAL_DESCONECTAR;
  if (pendiente >= desconectar) return { accion: 'desconectar', pendiente };
  if (pendiente >= suspender) return { accion: 'suspender', pendiente };
  if (conexion?.necesitaSnapshot) return { accion: 'snapshot', pendiente };
  return { accion: 'delta', pendiente };
}

// Dueño: Persona 2. Tablero /metrics por instancia (RT-7).
// Expone conexiones activas, mensajes por segundo, lag del Event Loop,
// memoria estimada por conexión y la latencia recepción de acta → publicación.
import { leerLag } from './event_loop_lag.js';

const VENTANA_MS = 1000;
const TOPE_LATENCIAS = 256;

const estado = {
  total: 0,
  /** @type {number[]} timestamps de cada mensaje publicado, para la tasa. */
  marcas: [],
  /** @type {number[]} ms entre recepción y publicación. */
  latencias: [],
};

function escapar(valor) {
  return String(valor ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '');
}

function podar(ahora) {
  const corte = ahora - VENTANA_MS;
  while (estado.marcas.length > 0 && estado.marcas[0] < corte) estado.marcas.shift();
}

function media(valores) {
  if (valores.length === 0) return 0;
  let suma = 0;
  for (const v of valores) suma += v;
  return suma / valores.length;
}

/** Cuenta mensajes que sí salieron hacia el público. `recibidoEn` mide la latencia. */
export function registrarPublicacion(info = {}) {
  const n = info.n ?? 1;
  const publicadoEn = info.publicadoEn ?? Date.now();
  for (let i = 0; i < n; i += 1) estado.marcas.push(publicadoEn);
  estado.total += n;
  if (info.recibidoEn != null) {
    estado.latencias.push(Math.max(0, publicadoEn - info.recibidoEn));
    if (estado.latencias.length > TOPE_LATENCIAS) {
      estado.latencias.splice(0, estado.latencias.length - TOPE_LATENCIAS);
    }
  }
  podar(publicadoEn);
}

/** Compatibilidad con el stub anterior: solo incrementa el contador. */
export function contarMensajes(n = 1) {
  registrarPublicacion({ n });
}

export function reiniciarMetricas() {
  estado.total = 0;
  estado.marcas.length = 0;
  estado.latencias.length = 0;
}

export function leerTablero({ instancia, conexiones = 0 } = {}) {
  const ahora = Date.now();
  podar(ahora);
  const lag = leerLag();
  const rss = process.memoryUsage().rss;
  const activas = conexiones ?? 0;
  return {
    instancia,
    conexiones_activas: activas,
    mensajes_emitidos_total: estado.total,
    mensajes_por_segundo: estado.marcas.length,
    event_loop_lag_ms: lag.mean_ms,
    event_loop_lag_p99_ms: lag.p99_ms,
    event_loop_lag_max_ms: lag.max_ms,
    memoria_por_conexion_bytes: activas > 0 ? Math.round(rss / activas) : 0,
    memoria_rss_bytes: rss,
    latencia_acta_publicacion_ms: media(estado.latencias),
  };
}

/** Texto Prometheus. `conexiones` es el número de clientes vivos de esta instancia. */
export function exponer({ instancia, conexiones = 0 } = {}) {
  const t = leerTablero({ instancia, conexiones });
  const etiqueta = `{instancia="${escapar(instancia)}"}`;
  const linea = (nombre, valor) => `${nombre}${etiqueta} ${valor}`;
  return [
    '# HELP preconteo_conexiones Conexiones activas en la instancia',
    '# TYPE preconteo_conexiones gauge',
    linea('preconteo_conexiones', t.conexiones_activas),
    '# HELP preconteo_mensajes_emitidos_total Mensajes publicados al público',
    '# TYPE preconteo_mensajes_emitidos_total counter',
    linea('preconteo_mensajes_emitidos_total', t.mensajes_emitidos_total),
    '# HELP preconteo_mensajes_por_segundo Mensajes publicados en el último segundo',
    '# TYPE preconteo_mensajes_por_segundo gauge',
    linea('preconteo_mensajes_por_segundo', t.mensajes_por_segundo),
    '# HELP preconteo_eventloop_lag_ms Retraso medio del Event Loop',
    '# TYPE preconteo_eventloop_lag_ms gauge',
    linea('preconteo_eventloop_lag_ms', t.event_loop_lag_ms.toFixed(3)),
    linea('preconteo_eventloop_delay_p99_ms', t.event_loop_lag_p99_ms.toFixed(3)),
    linea('preconteo_eventloop_delay_max_ms', t.event_loop_lag_max_ms.toFixed(3)),
    '# HELP preconteo_memoria_por_conexion_bytes RSS de la instancia repartido entre conexiones',
    '# TYPE preconteo_memoria_por_conexion_bytes gauge',
    linea('preconteo_memoria_por_conexion_bytes', t.memoria_por_conexion_bytes),
    linea('preconteo_memoria_rss_bytes', t.memoria_rss_bytes),
    '# HELP preconteo_latencia_acta_publicacion_ms Latencia media recepción de acta → publicación',
    '# TYPE preconteo_latencia_acta_publicacion_ms gauge',
    linea('preconteo_latencia_acta_publicacion_ms', t.latencia_acta_publicacion_ms.toFixed(3)),
    '',
  ].join('\n');
}

/** Registra GET /metrics. `obtenerConexiones` la aporta el fan-out de esta instancia. */
export function registrarRuta(app, obtenerConexiones) {
  app.get('/metrics', async (_req, reply) => {
    const conexiones = typeof obtenerConexiones === 'function' ? obtenerConexiones() : 0;
    reply.type('text/plain; version=0.0.4');
    return exponer({ instancia: app.instanceId, conexiones });
  });
}

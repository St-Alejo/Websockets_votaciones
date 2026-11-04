// Dueño: Persona 2. STUB de métricas (RT-4, RT-7). El real debe exponer, por instancia:
// conexiones, mensajes emitidos/s, retraso del Event Loop, memoria por conexión,
// actas por minuto y retraso recepción→publicación.
import { monitorEventLoopDelay } from 'node:perf_hooks';

const histograma = monitorEventLoopDelay({ resolution: 20 });
histograma.enable();

const contadores = { mensajes_emitidos_total: 0 };

export function contarMensajes(n = 1) {
  contadores.mensajes_emitidos_total += n;
}

/** Texto en formato Prometheus. */
export function exponer({ instancia, conexiones = 0 }) {
  const etiqueta = `{instancia="${instancia}"}`;
  const ms = (ns) => (Number.isFinite(ns) ? ns / 1e6 : 0).toFixed(3);
  return [
    '# STUB: métricas mínimas de Persona 2',
    `preconteo_conexiones${etiqueta} ${conexiones}`,
    `preconteo_mensajes_emitidos_total${etiqueta} ${contadores.mensajes_emitidos_total}`,
    `preconteo_eventloop_delay_p99_ms${etiqueta} ${ms(histograma.percentile(99))}`,
    `preconteo_eventloop_delay_max_ms${etiqueta} ${ms(histograma.max)}`,
    `preconteo_memoria_rss_bytes${etiqueta} ${process.memoryUsage().rss}`,
    '',
  ].join('\n');
}

// Dueño: Persona 2. Retraso del Event Loop (RT-4, RT-7).
// `monitorEventLoopDelay` muestrea de forma continua; los valores salen en ms.
import { monitorEventLoopDelay } from 'node:perf_hooks';

const histograma = monitorEventLoopDelay({ resolution: 20 });
histograma.enable();

function aMs(nanos) {
  const n = Number(nanos);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n / 1e6;
}

function percentil(p) {
  try {
    return aMs(histograma.percentile(p));
  } catch {
    return 0;
  }
}

/** Lectura actual del lag. No reinicia el histograma. */
export function leerLag() {
  return {
    min_ms: aMs(histograma.min),
    mean_ms: aMs(histograma.mean),
    p50_ms: percentil(50),
    p99_ms: percentil(99),
    max_ms: aMs(histograma.max),
  };
}

export function reiniciarLag() {
  histograma.reset();
}

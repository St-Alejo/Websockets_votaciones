import { monitorEventLoopDelay } from 'node:perf_hooks';

const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();

function toMs(nanos) {
  const n = Number(nanos);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n / 1e6;
}

function percentile(p) {
  try {
    return toMs(histogram.percentile(p));
  } catch {
    return 0;
  }
}

export function readLag() {
  return {
    min_ms: toMs(histogram.min),
    mean_ms: toMs(histogram.mean),
    p50_ms: percentile(50),
    p99_ms: percentile(99),
    max_ms: toMs(histogram.max),
  };
}

export function resetLag() {
  histogram.reset();
}

import { readLag } from './event_loop_lag.js';

const WINDOW_MS = 1000;
const MAX_LATENCIES = 256;

const state = {
  total: 0,
  marks: [],
  latencies: [],
};

function escapeLabel(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '');
}

function prune(now) {
  const cutoff = now - WINDOW_MS;
  while (state.marks.length > 0 && state.marks[0] < cutoff) state.marks.shift();
}

function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function recordPublish(info = {}) {
  const n = info.n ?? 1;
  const publishedAt = info.publishedAt ?? Date.now();
  for (let i = 0; i < n; i += 1) state.marks.push(publishedAt);
  state.total += n;
  if (info.receivedAt != null) {
    state.latencies.push(Math.max(0, publishedAt - info.receivedAt));
    if (state.latencies.length > MAX_LATENCIES) {
      state.latencies.splice(0, state.latencies.length - MAX_LATENCIES);
    }
  }
  prune(publishedAt);
}

export function countMessages(n = 1) {
  recordPublish({ n });
}

export function resetMetrics() {
  state.total = 0;
  state.marks.length = 0;
  state.latencies.length = 0;
}

export function readDashboard({ instance, connections = 0 } = {}) {
  const now = Date.now();
  prune(now);
  const lag = readLag();
  const rss = process.memoryUsage().rss;
  const active = connections ?? 0;
  return {
    instance,
    active_connections: active,
    messages_sent_total: state.total,
    messages_per_second: state.marks.length,
    event_loop_lag_ms: lag.mean_ms,
    event_loop_lag_p99_ms: lag.p99_ms,
    event_loop_lag_max_ms: lag.max_ms,
    memory_per_connection_bytes: active > 0 ? Math.round(rss / active) : 0,
    memory_rss_bytes: rss,
    tally_publish_latency_ms: mean(state.latencies),
  };
}

export function expose({ instance, connections = 0 } = {}) {
  const t = readDashboard({ instance, connections });
  const label = `{instance="${escapeLabel(instance)}"}`;
  const line = (name, value) => `${name}${label} ${value}`;
  return [
    '# HELP preconteo_connections Active connections on the instance',
    '# TYPE preconteo_connections gauge',
    line('preconteo_connections', t.active_connections),
    '# HELP preconteo_messages_sent_total Messages published to the public',
    '# TYPE preconteo_messages_sent_total counter',
    line('preconteo_messages_sent_total', t.messages_sent_total),
    '# HELP preconteo_messages_per_second Messages published in the last second',
    '# TYPE preconteo_messages_per_second gauge',
    line('preconteo_messages_per_second', t.messages_per_second),
    '# HELP preconteo_eventloop_lag_ms Mean Event Loop delay',
    '# TYPE preconteo_eventloop_lag_ms gauge',
    line('preconteo_eventloop_lag_ms', t.event_loop_lag_ms.toFixed(3)),
    line('preconteo_eventloop_delay_p99_ms', t.event_loop_lag_p99_ms.toFixed(3)),
    line('preconteo_eventloop_delay_max_ms', t.event_loop_lag_max_ms.toFixed(3)),
    '# HELP preconteo_memory_per_connection_bytes Instance RSS divided among connections',
    '# TYPE preconteo_memory_per_connection_bytes gauge',
    line('preconteo_memory_per_connection_bytes', t.memory_per_connection_bytes),
    line('preconteo_memory_rss_bytes', t.memory_rss_bytes),
    '# HELP preconteo_tally_publish_latency_ms Mean latency from tally reception to publication',
    '# TYPE preconteo_tally_publish_latency_ms gauge',
    line('preconteo_tally_publish_latency_ms', t.tally_publish_latency_ms.toFixed(3)),
    '',
  ].join('\n');
}

export function registerRoute(app, getConnections) {
  app.get('/metrics', async (_req, reply) => {
    const connections = typeof getConnections === 'function' ? getConnections() : 0;
    reply.type('text/plain; version=0.0.4');
    return expose({ instance: app.instanceId, connections });
  });
}

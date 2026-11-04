import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTopics } from '../../src/fanout/topics.js';
import { readLag } from '../../src/metrics/event_loop_lag.js';
import { expose, readDashboard, recordPublish, resetMetrics } from '../../src/metrics/dashboard.js';
import { testApp } from '../../test/helpers.js';

describe('RT-7 metrics dashboard', () => {
  let app;

  beforeAll(async () => {
    app = await testApp();
    await app.ready();
  });

  afterAll(async () => {
    resetTopics();
    await app.close();
  });

  beforeEach(() => {
    resetMetrics();
    resetTopics();
  });

  it('measures event loop lag, rate, memory per connection and tally latency', () => {
    const lag = readLag();
    expect(lag.mean_ms).toBeGreaterThanOrEqual(0);
    expect(lag.p99_ms).toBeGreaterThanOrEqual(0);
    expect(lag.max_ms).toBeGreaterThanOrEqual(0);

    const receivedAt = Date.now() - 40;
    recordPublish({ n: 4, receivedAt, publishedAt: Date.now() });
    const dashboard = readDashboard({ instance: 'inst-a', connections: 2 });
    expect(dashboard.messages_per_second).toBe(4);
    expect(dashboard.messages_sent_total).toBe(4);
    expect(dashboard.tally_publish_latency_ms).toBeGreaterThanOrEqual(40);
    expect(dashboard.memory_per_connection_bytes).toBeGreaterThan(0);
    expect(dashboard.event_loop_lag_ms).toBeGreaterThanOrEqual(0);

    const text = expose({ instance: 'inst-a', connections: 2 });
    for (const name of [
      'preconteo_connections',
      'preconteo_messages_per_second',
      'preconteo_eventloop_lag_ms',
      'preconteo_memory_per_connection_bytes',
      'preconteo_tally_publish_latency_ms',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toContain('preconteo_messages_per_second{instance="inst-a"} 4');
    expect(text).toContain('preconteo_connections{instance="inst-a"} 2');
  });

  it('GET /metrics publishes the instance Prometheus dashboard', async () => {
    const res = await app.inject('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    for (const name of [
      'preconteo_connections',
      'preconteo_messages_per_second',
      'preconteo_eventloop_lag_ms',
      'preconteo_memory_per_connection_bytes',
      'preconteo_tally_publish_latency_ms',
    ]) {
      expect(res.body).toMatch(new RegExp(`${name}\\{instance="test-1"\\} \\d`));
    }
  });
});

import { parseTopic } from '../../contracts/channels.js';
import {
  bindBackplane,
  checkPressure,
  releaseHeld,
  subscribe,
  unsubscribe,
} from '../../fanout/index.js';
import { decideResume, readCursor, retryDirective } from '../../transport/reconnection.js';
import { SSE_HEADERS, createSseConnection, startHeartbeat } from '../../transport/sse.js';

const HEARTBEAT_MS = 15_000;

export default async function ssePublic(app) {
  bindBackplane(app.redisSub).catch((err) =>
    app.log.warn({ msg: err.message }, 'could not subscribe to tally:new'),
  );

  app.get('/sse/public', async (req, reply) => {
    const topic = req.query.topic ?? 'dept';
    try {
      parseTopic(topic);
    } catch {
      return reply.code(400).send({ error: 'invalid_topic', example: 'mun:11' });
    }

    const cursor = readCursor(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, SSE_HEADERS);
    res.write(`retry: ${retryDirective()}\n\n`);

    const connection = createSseConnection(res, { topic });
    connection.accepts = false;
    subscribe(connection, topic);

    let closed = false;
    const stopHeartbeat = startHeartbeat(res, HEARTBEAT_MS, {
      onHeartbeat: () => checkPressure(connection),
    });
    const close = () => {
      if (closed) return;
      closed = true;
      connection.closed = true;
      stopHeartbeat();
      unsubscribe(connection, topic);
    };
    req.raw.on('close', close);
    res.on('error', close);

    try {
      const plan = await decideResume({ cursor, topic });
      if (res.destroyed || res.writableEnded) {
        close();
        return;
      }
      if (plan.mode === 'snapshot') {
        const snap = { ...plan.snapshot, instance: app.instanceId };
        connection.seenUntil = plan.snapshot.stream_id;
        connection.send('snapshot', snap, plan.snapshot.stream_id);
      } else {
        connection.seenUntil = cursor;
        for (const ev of plan.events) {
          connection.send('delta', { topic, stream_id: ev.stream_id, events: [ev] }, ev.stream_id);
          connection.seenUntil = ev.stream_id;
        }
      }
      releaseHeld(connection);
    } catch (err) {
      app.log.error({ err }, 'sse resume');
      if (!res.writableEnded && !res.destroyed) {
        connection.send('error', { reason: 'resume_failed' });
        releaseHeld(connection);
      }
    }
  });
}

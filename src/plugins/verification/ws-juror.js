import { IncomingTally } from '../../contracts/schemas.js';
import { registerTally } from '../../domain/index.js';
import { registerClients } from '../../redis/client.js';

export const MAX_MESSAGE_BYTES = 64 * 1024;

export default async function wsJuror(app) {
  registerClients({ redis: app.redis, redisSub: app.redisSub });

  app.get('/ws/juror', { websocket: true }, (socket, req) => {
    let juror =
      typeof req.query.juror === 'string' && req.query.juror.trim() !== ''
        ? req.query.juror.trim()
        : null;

    const send = (msg) => {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        return;
      }
    };
    send({ type: 'hello', instance: app.instanceId });

    socket.on('message', async (raw) => {
      const text = raw.toString();
      if (text.length > MAX_MESSAGE_BYTES) {
        send({ type: 'error', reason: 'message_too_large', max_bytes: MAX_MESSAGE_BYTES });
        try {
          socket.close(1009, 'message_too_large');
        } catch {
          return;
        }
        return;
      }
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return send({ type: 'error', reason: 'invalid_json' });
      }
      if (!msg || typeof msg.type !== 'string') {
        return send({ type: 'error', reason: 'unknown_type' });
      }

      switch (msg.type) {
        case 'hello': {
          if (typeof msg.juror === 'string' && msg.juror.trim() !== '') {
            juror = msg.juror.trim();
          }
          if (!juror) return send({ type: 'error', reason: 'missing_juror' });
          return send({ type: 'hello', instance: app.instanceId, juror });
        }
        case 'tally': {
          const r = IncomingTally.safeParse(msg.tally);
          if (!r.success) {
            return send({
              type: 'error',
              reason: 'invalid_tally',
              details: r.error.issues
                .slice(0, 5)
                .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                .join('; '),
            });
          }
          if (juror && r.data.juror !== juror) {
            return send({ type: 'error', reason: 'juror_mismatch' });
          }
          let response;
          try {
            response = await registerTally(r.data);
          } catch (err) {
            app.log.error({ err }, 'ws-juror: registerTally failed');
            return send({ type: 'error', reason: 'register_failed' });
          }
          return send({ type: 'response', response });
        }
        default:
          return send({ type: 'error', reason: 'unknown_type' });
      }
    });
  });
}

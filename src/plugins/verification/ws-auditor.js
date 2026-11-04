import { CHANNELS } from '../../contracts/channels.js';
import { updateTally, heartbeat, presentAuditors, leave } from '../../presence/index.js';
import { registerClients } from '../../redis/client.js';
import { stopHeartbeat, startHeartbeat } from '../../verification/heartbeat.js';
import { releaseCase, resolveCase, takeCase, viewQueue } from '../../verification/index.js';

export const MAX_MESSAGE_BYTES = 64 * 1024;
const AUDITOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

function broadcast(app, msg) {
  const text = JSON.stringify(msg);
  for (const s of app.auditorSockets ?? []) {
    try {
      if (s.readyState === 1) s.send(text);
    } catch {
      continue;
    }
  }
}

async function subscribeBackplane(app) {
  if (app._auditorBackplane) return;
  app._auditorBackplane = true;
  const sub = app.redisSub;
  if (!sub || typeof sub.subscribe !== 'function') {
    app.log.warn('ws-auditor: no redisSub, no cross-instance broadcast (degraded mode)');
    return;
  }
  try {
    await sub.subscribe(CHANNELS.VERIFICATION, CHANNELS.PRESENCE);
  } catch (err) {
    app.log.warn({ err }, 'ws-auditor: could not subscribe to the backplane');
    return;
  }
  if (typeof sub.on === 'function') {
    sub.on('message', async (channel, text) => {
      try {
        const event = JSON.parse(text);
        if (channel === CHANNELS.VERIFICATION) {
          const queue = await viewQueue().catch(() => null);
          if (queue) broadcast(app, { type: 'queue', queue, event });
        } else if (channel === CHANNELS.PRESENCE) {
          const list = await presentAuditors().catch(() => null);
          if (list) broadcast(app, { type: 'present', present: list, event });
        }
      } catch (err) {
        app.log.warn({ err }, 'ws-auditor: invalid backplane event');
      }
    });
  }
}

export default async function wsAuditor(app) {
  registerClients({ redis: app.redis, redisSub: app.redisSub });
  app.auditorSockets = new Set();
  subscribeBackplane(app).catch((err) =>
    app.log.warn({ msg: err.message }, 'could not subscribe to the auditor backplane'),
  );

  app.get('/ws/auditor', { websocket: true }, (socket, req) => {
    const auditor = String(req.query.auditor ?? '').trim();
    const send = (msg) => {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        return;
      }
    };
    if (!AUDITOR_ID.test(auditor)) {
      send({ type: 'error', reason: 'missing_auditor' });
      try {
        socket.close(4001, 'missing_auditor');
      } catch {
        return;
      }
      return;
    }
    app.auditorSockets.add(socket);

    let currentTally = null;
    let currentToken = null;
    let hb = null;

    const dropLocalCase = () => {
      if (hb) {
        try {
          hb.stop();
        } catch {
          hb = null;
        }
        hb = null;
      } else if (currentTally && currentToken) {
        try {
          stopHeartbeat(currentTally, currentToken);
        } catch {
          currentTally = null;
        }
      }
      currentTally = null;
      currentToken = null;
    };

    socket.on('message', async (raw) => {
      const text = raw.toString();
      if (text.length > MAX_MESSAGE_BYTES) {
        send({ type: 'error', reason: 'message_too_large' });
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

      try {
        switch (msg.type) {
          case 'heartbeat': {
            const tally = typeof msg.tally === 'string' ? msg.tally : (currentTally ?? null);
            await heartbeat(auditor, { instance: app.instanceId, current_tally: tally });
            return send({ type: 'heartbeat_ok' });
          }
          case 'take': {
            if (currentToken) {
              return send({ type: 'error', reason: 'already_has_case', tally: currentTally });
            }
            const kase = await takeCase(auditor);
            if (!kase) return send({ type: 'case', case: null });
            currentTally = kase.tally;
            currentToken = kase.token;
            await updateTally(auditor, currentTally).catch(() => null);
            hb = startHeartbeat(currentTally, currentToken, {
              redis: app.redis,
              onLost: () => {
                send({ type: 'lock_lost', tally: currentTally });
                dropLocalCase();
                updateTally(auditor, null).catch(() => null);
              },
            });
            return send({ type: 'case', case: kase });
          }
          case 'release': {
            if (typeof msg.tally !== 'string' || typeof msg.token !== 'string') {
              return send({ type: 'error', reason: 'invalid_request' });
            }
            const ok = await releaseCase(auditor, msg.tally, msg.token);
            if (ok && msg.tally === currentTally) {
              dropLocalCase();
              await updateTally(auditor, null).catch(() => null);
            }
            return send({ type: 'released', tally: msg.tally, ok });
          }
          case 'complete': {
            if (typeof msg.tally !== 'string' || typeof msg.token !== 'string') {
              return send({ type: 'error', reason: 'invalid_request' });
            }
            const ok = await resolveCase(auditor, msg.tally, msg.token);
            if (ok && msg.tally === currentTally) {
              dropLocalCase();
              await updateTally(auditor, null).catch(() => null);
            }
            return send({ type: 'completed', tally: msg.tally, ok });
          }
          case 'queue':
            return send({ type: 'queue', queue: await viewQueue() });
          case 'present':
            return send({ type: 'present', present: await presentAuditors() });
          default:
            return send({ type: 'error', reason: 'unknown_type' });
        }
      } catch (err) {
        app.log.error({ err, auditor }, 'ws-auditor: operation failed');
        return send({ type: 'error', reason: 'operation_failed' });
      }
    });

    socket.on('close', () => {
      app.auditorSockets.delete(socket);
      dropLocalCase();
      leave(auditor).catch((err) => app.log.warn({ err }, 'ws-auditor: leave failed'));
    });

    (async () => {
      await heartbeat(auditor, { instance: app.instanceId });
      send({
        type: 'hello',
        instance: app.instanceId,
        queue: await viewQueue().catch(() => []),
        present: await presentAuditors().catch(() => []),
      });
    })().catch((err) => app.log.error({ err }, 'ws-auditor'));
  });
}

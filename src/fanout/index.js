import { CHANNELS } from '../contracts/channels.js';
import { snapshot } from '../domain/index.js';
import { recordPublish } from '../metrics/dashboard.js';
import { evaluate } from './backpressure.js';
import { compareStreamIds, createEngine } from './engine.js';
import {
  cleanup,
  connectionsOf,
  stats as topicStats,
  subscribe as addSubscription,
  unsubscribe as removeSubscription,
} from './topics.js';

const batchSize = Number(process.env.FANOUT_BATCH) || 200;
const windowMs = Number(process.env.FANOUT_WINDOW_MS ?? 50);

function sendSnapshot(connection, topic) {
  const target = topic || connection.topic;
  if (!target || connection.closed) return;
  Promise.resolve(snapshot([target]))
    .then((snap) => {
      if (connection.closed || typeof connection.send !== 'function') return;
      if (!connection.seenByTopic) connection.seenByTopic = new Map();
      const previous = connection.seenByTopic.get(target);
      if (!previous || compareStreamIds(snap.stream_id, previous) > 0) {
        connection.seenByTopic.set(target, snap.stream_id);
      }
      if (!connection.seenUntil || compareStreamIds(snap.stream_id, connection.seenUntil) > 0) {
        connection.seenUntil = snap.stream_id;
      }
      connection.send('snapshot', { ...snap, reason: 'backpressure' }, snap.stream_id);
      recordPublish({ n: 1 });
    })
    .catch(() => {
      connection.needsSnapshot = true;
    });
}

const engine = createEngine({
  batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 200,
  windowMs: Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : 50,
  resolveConnections: (topic) => connectionsOf(topic),
  evaluate: (connection) => evaluate(connection),
  onEmit: (info) => recordPublish(info),
  onDisconnect: (connection) => {
    cleanup(connection);
    try {
      connection.close?.('slow');
    } catch {
      return;
    }
  },
  sendSnapshot: (connection, topic) => sendSnapshot(connection, topic),
});

export function subscribe(connection, topic) {
  addSubscription(connection, topic);
}

export function unsubscribe(connection, topic) {
  removeSubscription(connection, topic);
}

export function subscribers(topic) {
  return connectionsOf(topic);
}

export function cleanConnection(connection) {
  cleanup(connection);
}

export function stats() {
  const topics = topicStats();
  const delivery = engine.stats();
  return {
    topics: topics.topics,
    subscriptions: topics.subscriptions,
    connections: topics.connections,
    naive_messages: delivery.naiveMessages,
    sent_messages: delivery.messagesSent,
    events_ingested: delivery.eventsIngested,
  };
}

export function publish(event) {
  engine.ingest(event);
}

export function releaseHeld(connection) {
  const queue = connection.held ?? [];
  connection.held = [];
  connection.accepts = true;
  for (const message of queue) engine.deliver(connection, message);
}

export function checkPressure(connection) {
  if (!connection || connection.closed) return;
  const decision = evaluate(connection);
  if (decision.action === 'disconnect') {
    connection.closed = true;
    connection.needsSnapshot = false;
    cleanup(connection);
    try {
      connection.close?.('slow');
    } catch {
      return;
    }
    return;
  }
  if (decision.action === 'suspend') {
    connection.needsSnapshot = true;
    return;
  }
  if (decision.action === 'snapshot') {
    connection.needsSnapshot = false;
    sendSnapshot(connection, connection.topic);
  }
}

const bound = new WeakSet();

export async function bindBackplane(redisSub) {
  if (!redisSub || typeof redisSub.subscribe !== 'function') return false;
  if (bound.has(redisSub)) return true;
  bound.add(redisSub);
  redisSub.on('message', (channel, raw) => {
    if (channel !== CHANNELS.NEW_TALLY) return;
    try {
      const event = JSON.parse(raw);
      event._receivedAt = Date.now();
      engine.ingest(event);
    } catch {
      return;
    }
  });
  await redisSub.subscribe(CHANNELS.NEW_TALLY);
  return true;
}

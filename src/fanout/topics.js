const byTopic = new Map();

const byConnection = new Map();

function requireArgs(connection, topic) {
  if (!connection || typeof connection !== 'object') {
    throw new Error('The connection is required');
  }
  if (topic == null || topic === '') {
    throw new Error('The topic is required');
  }
}

export function subscribe(connection, topic) {
  requireArgs(connection, topic);
  let set = byTopic.get(topic);
  if (!set) {
    set = new Set();
    byTopic.set(topic, set);
  }
  set.add(connection);

  let topics = byConnection.get(connection);
  if (!topics) {
    topics = new Set();
    byConnection.set(connection, topics);
  }
  topics.add(topic);
}

export function unsubscribe(connection, topic) {
  if (!connection || topic == null) return;
  const set = byTopic.get(topic);
  if (set) {
    set.delete(connection);
    if (set.size === 0) byTopic.delete(topic);
  }
  const topics = byConnection.get(connection);
  if (!topics) return;
  topics.delete(topic);
  if (topics.size === 0) byConnection.delete(connection);
}

export function cleanup(connection) {
  if (!connection) return;
  const topics = byConnection.get(connection);
  if (!topics) return;
  for (const topic of topics) {
    const set = byTopic.get(topic);
    if (!set) continue;
    set.delete(connection);
    if (set.size === 0) byTopic.delete(topic);
  }
  byConnection.delete(connection);
}

export function connectionsOf(topic) {
  return byTopic.get(topic) ?? new Set();
}

export function traverse(topic, visit) {
  const set = byTopic.get(topic);
  if (!set) return 0;
  let n = 0;
  for (const connection of set) {
    visit(connection);
    n += 1;
  }
  return n;
}

export function stats() {
  let subscriptions = 0;
  for (const set of byTopic.values()) subscriptions += set.size;
  return {
    topics: byTopic.size,
    subscriptions,
    connections: byConnection.size,
  };
}

export function resetTopics() {
  byTopic.clear();
  byConnection.clear();
}

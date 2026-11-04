export function affectedTopics(event) {
  const topics = ['dept'];
  if (event?.mun != null) topics.push(`mun:${event.mun}`);
  if (event?.station != null) topics.push(`station:${event.station}`);
  if (event?.table != null) topics.push(`table:${event.table}`);
  return topics;
}

export function compareStreamIds(a, b) {
  const pa = splitId(a);
  const pb = splitId(b);
  if (pa.ms !== pb.ms) return pa.ms - pb.ms;
  return pa.seq - pb.seq;
}

function splitId(id) {
  const [ms, seq] = String(id ?? '0-0').split('-');
  const nms = Number(ms);
  const nseq = Number(seq ?? 0);
  return {
    ms: Number.isFinite(nms) ? nms : 0,
    seq: Number.isFinite(nseq) ? nseq : 0,
  };
}

function publicEvent(event) {
  const result = {
    stream_id: event.stream_id,
    tally: event.tally,
    mun: event.mun,
    station: event.station,
    version: event.version,
    type: event.type,
  };
  if (event.table != null) result.table = event.table;
  return result;
}

function seenFor(connection, topic) {
  const specific = connection.seenByTopic?.get(topic);
  if (specific) return specific;
  return connection.seenUntil ?? null;
}

function markSeen(connection, message) {
  const id = message.id;
  if (!id) return;
  if (!connection.seenByTopic) connection.seenByTopic = new Map();
  const current = connection.seenByTopic.get(message.topic);
  if (!current || compareStreamIds(id, current) > 0) {
    connection.seenByTopic.set(message.topic, id);
  }
  if (!connection.seenUntil || compareStreamIds(id, connection.seenUntil) > 0) {
    connection.seenUntil = id;
  }
}

function filterSeen(connection, message) {
  const floor = seenFor(connection, message.topic);
  const original = message.data?.events;
  if (!Array.isArray(original)) return message;
  const events = floor
    ? original.filter((e) => e?.stream_id && compareStreamIds(e.stream_id, floor) > 0)
    : original.slice();
  if (events.length === 0) return null;
  const streamId = events.reduce(
    (max, e) => (compareStreamIds(e.stream_id, max) > 0 ? e.stream_id : max),
    events[0].stream_id,
  );
  return {
    ...message,
    id: streamId,
    data: { ...message.data, events, stream_id: streamId },
  };
}

export function createEngine(options = {}) {
  const batchSize = Math.max(1, Math.floor(Number(options.batchSize ?? 200)) || 1);
  const rawWindow = options.windowMs ?? 50;
  const windowMs = Math.max(0, Number.isFinite(Number(rawWindow)) ? Number(rawWindow) : 0);
  const yieldControl = options.yieldControl ?? setImmediate;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((id) => clearTimeout(id));
  const resolve = options.resolveConnections ?? (() => []);
  const topicsOf = options.topicsOf ?? affectedTopics;
  const evaluateClient = options.evaluate ?? (() => ({ action: 'delta' }));
  const send =
    options.send ??
    ((connection, message) => {
      connection.send(message.event, message.data, message.id);
    });
  const sendSnapshot =
    options.sendSnapshot ??
    ((connection, topic) => {
      connection.send('snapshot', { topic, reason: 'backpressure' }, connection.seenUntil);
    });
  const onDisconnect =
    options.onDisconnect ??
    ((connection) => {
      connection.closed = true;
      connection.close?.('slow');
    });
  const onEmit = options.onEmit ?? (() => {});

  let pending = new Map();
  let raw = new Map();
  let timer = null;
  const stats = {
    eventsIngested: 0,
    naiveMessages: 0,
    messagesSent: 0,
    yields: 0,
  };

  function account(message) {
    stats.messagesSent += 1;
    onEmit({ n: 1, receivedAt: message.receivedAt, publishedAt: Date.now() });
  }

  function deliver(connection, message) {
    if (!connection || connection.closed) return false;
    if (connection.accepts === false) {
      if (!connection.held) connection.held = [];
      connection.held.push(message);
      return false;
    }
    const filtered = filterSeen(connection, message);
    if (!filtered) return false;

    const decision = evaluateClient(connection);
    if (decision.action === 'disconnect') {
      connection.closed = true;
      connection.needsSnapshot = false;
      try {
        onDisconnect(connection, decision);
      } catch {
        return false;
      }
      return false;
    }
    if (decision.action === 'suspend') {
      connection.needsSnapshot = true;
      return false;
    }
    if (decision.action === 'snapshot') {
      connection.needsSnapshot = false;
      try {
        sendSnapshot(connection, filtered.topic);
        return true;
      } catch {
        connection.needsSnapshot = true;
        return false;
      }
    }
    try {
      send(connection, filtered);
      markSeen(connection, filtered);
      account(filtered);
      return true;
    } catch {
      return false;
    }
  }

  function sendBatches(jobs) {
    let index = 0;
    const step = () => {
      const end = Math.min(index + batchSize, jobs.length);
      for (; index < end; index += 1) {
        const job = jobs[index];
        try {
          deliver(job.connection, job.message);
        } catch {
          continue;
        }
      }
      if (index < jobs.length) {
        stats.yields += 1;
        yieldControl(step);
      }
    };
    if (jobs.length > 0) step();
  }

  function flush() {
    if (timer != null) {
      cancel(timer);
      timer = null;
    }
    const batch = pending;
    const raws = raw;
    pending = new Map();
    raw = new Map();

    const jobs = [];
    for (const [topic, bag] of batch) {
      if (bag.size === 0) continue;
      const list = [...bag.values()];
      const streamId = list.reduce(
        (max, e) => (!max || compareStreamIds(e.stream_id, max) > 0 ? e.stream_id : max),
        null,
      );
      const receivedAt = list.reduce(
        (min, e) => Math.min(min, e._receivedAt ?? Date.now()),
        Number.POSITIVE_INFINITY,
      );
      const message = {
        event: 'delta',
        topic,
        id: streamId,
        receivedAt: Number.isFinite(receivedAt) ? receivedAt : Date.now(),
        data: {
          topic,
          stream_id: streamId,
          events: list.map(publicEvent),
        },
      };
      const connections = [...(resolve(topic) ?? [])];
      stats.naiveMessages += (raws.get(topic) ?? list.length) * connections.length;
      for (const connection of connections) jobs.push({ connection, message });
    }
    sendBatches(jobs);
  }

  function ingest(event) {
    if (!event) return;
    stats.eventsIngested += 1;
    const ev = { ...event };
    if (ev._receivedAt == null) ev._receivedAt = Date.now();
    const key = ev.tally || ev.stream_id;
    for (const topic of topicsOf(ev)) {
      let bag = pending.get(topic);
      if (!bag) {
        bag = new Map();
        pending.set(topic, bag);
      }
      const previous = bag.get(key);
      if (!previous || (Number(ev.version) || 0) >= (Number(previous.version) || 0)) {
        bag.set(key, ev);
      }
      raw.set(topic, (raw.get(topic) ?? 0) + 1);
    }
    if (timer == null) timer = schedule(flush, windowMs);
  }

  function stop() {
    if (timer != null) {
      cancel(timer);
      timer = null;
    }
  }

  return {
    ingest,
    flush,
    deliver,
    stop,
    yieldControl,
    stats: () => ({ ...stats }),
  };
}

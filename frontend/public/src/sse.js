import { API_HTTP } from '../../config.js';
export function createSseClient({ onStatus, onSnapshot, onEvent }) {
  let es = null;
  let lastId = null;
  let topic = null;
  const seen = new Set();

  function connect(newTopic, resumeFrom = null, buildUrl) {
    close();
    topic = newTopic;
    if (resumeFrom) lastId = resumeFrom;
    let url = buildUrl(topic, lastId);
    onStatus?.('connecting', url);
    es = new EventSource(url);
    es.onopen = () => onStatus?.('connected');
    es.onerror = () => onStatus?.('reconnecting');
    es.addEventListener('snapshot', (ev) => {
      if (ev.lastEventId) lastId = ev.lastEventId;
      try {
        onSnapshot?.(JSON.parse(ev.data), ev.lastEventId ?? null);
      } catch {
        return;
      }
    });
    es.onmessage = (ev) => {
      const id = ev.lastEventId || null;
      if (id && seen.has(id)) return;
      if (id) {
        seen.add(id);
        if (seen.size > 500) seen.clear();
        lastId = id;
      }
      try {
        onEvent?.(ev.type, JSON.parse(ev.data), id);
      } catch {
        return;
      }
    };
  }

  function close() {
    if (es) {
      try {
        es.close();
      } catch {
        es = null;
      }
      es = null;
    }
  }

  return { connect, close, lastId: () => lastId, topic: () => topic };
}

export function defaultUrl(topic, lastId) {
  const q = new URLSearchParams({ topic });
  if (lastId) q.set('last_id', lastId);
  return `${API_HTTP}/sse/public?${q.toString()}`;
}

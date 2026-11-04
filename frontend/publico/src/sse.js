// Cliente SSE del público (RT-5: el público consume Server-Sent Events,
// nunca WebSocket). Usa EventSource nativo: reconexión automática con
// Last-Event-ID (el servidor envía `id:` con cada evento) y `ultimo_id`
// para reanudar (RF-6). Se ignoran eventos duplicados por id.
import { API_HTTP } from '../../config.js';
export function crearClienteSSE({ onEstado, onSnapshot, onEvento }) {
  let es = null;
  let ultimoId = null;
  let topico = null;
  const vistos = new Set();

  function conectar(nuevoTopico, reanudarDesde = null, construirUrl) {
    cerrar();
    topico = nuevoTopico;
    if (reanudarDesde) ultimoId = reanudarDesde;
    let url = construirUrl(topico, ultimoId);
    onEstado?.('conectando', url);
    es = new EventSource(url);
    es.onopen = () => onEstado?.('conectada');
    es.onerror = () => onEstado?.('reconectando');
    es.addEventListener('snapshot', (ev) => {
      if (ev.lastEventId) ultimoId = ev.lastEventId;
      try {
        onSnapshot?.(JSON.parse(ev.data), ev.lastEventId ?? null);
      } catch {
        /* snapshot malformado: se ignora, llegará el siguiente */
      }
    });
    // Eventos futuros de P2 (deltas del backplane): se reenvían tal cual para
    // fusionarlos en el snapshot. Los latidos (`: latido`) no llegan aquí.
    es.onmessage = (ev) => {
      const id = ev.lastEventId || null;
      if (id && vistos.has(id)) return; // duplica de red: ignorar
      if (id) {
        vistos.add(id);
        if (vistos.size > 500) vistos.clear();
        ultimoId = id;
      }
      try {
        onEvento?.(ev.type, JSON.parse(ev.data), id);
      } catch {
        /* evento malformado: ignorar */
      }
    };
  }

  function cerrar() {
    if (es) {
      try {
        es.close();
      } catch {
        /* ya cerrado */
      }
      es = null;
    }
  }

  return { conectar, cerrar, ultimoId: () => ultimoId, topico: () => topico };
}

export function urlPorDefecto(topico, ultimoId) {
  const q = new URLSearchParams({ topico });
  if (ultimoId) q.set('ultimo_id', ultimoId);
  return `${API_HTTP}/sse/publico?${q.toString()}`;
}

// Render de la consola a partir del estado. Sin framework.
export function formatearActa(id) {
  // E14-puesto-mesa-corporación → { puesto, mesa, corp }. Municipio no viene
  // en el id: se muestra n/d (pendiente del payload de P1).
  const m = /^E14-(\d+)-(\d+)-(\d+)$/.exec(id ?? '');
  if (!m) return { puesto: 'n/d', mesa: 'n/d' };
  return { puesto: m[1], mesa: m[2] };
}

export function haceCuanto(ms) {
  if (!ms) return 'n/d';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return 'ahora';
  if (s < 60) return `hace ${s}s`;
  return `hace ${Math.floor(s / 60)}min`;
}

export function filtrarCola(cola, { texto, estado, prioMin, yo }) {
  return cola.filter((c) => {
    if (texto && !c.acta.toLowerCase().includes(texto.toLowerCase())) return false;
    if (prioMin !== '' && Number(c.prioridad) < Number(prioMin)) return false;
    const asignada = !!c.asignada_a;
    if (estado === 'libre' && asignada) return false;
    if (estado === 'asignada' && !asignada) return false;
    if (estado === 'mia' && c.asignada_a !== yo) return false;
    return true;
  });
}

export function pintar(estado, refs) {
  const libres = estado.cola.filter((c) => !c.asignada_a).length;
  refs.stPend.textContent = libres;
  refs.stAsig.textContent = estado.cola.length - libres;
  refs.stRes.textContent = estado.resueltasSesion;
  const online = [...estado.conocidos.values()].filter((c) => c.online).length;
  refs.stOn.textContent = online;
  refs.stOff.textContent = estado.conocidos.size - online;

  const badge = refs.badge;
  badge.className = 'badge ' + (estado.conectada === true ? 'on' : estado.conectada === 'x' ? 'off' : 'mid');
  badge.textContent = estado.conectada === true ? 'conectado' : estado.conectada === 'x' ? 'desconectado' : 'conectando…';

  pintarMiCaso(estado, refs);
  pintarLog(estado, refs);
}

function pintarMiCaso(estado, refs) {
  const el = refs.miCaso;
  if (!estado.miCaso) {
    el.innerHTML = 'Sin caso asignado.';
    return;
  }
  el.innerHTML =
    `<strong>${escapeHtml(estado.miCaso.acta)}</strong><br>` +
    `<span class="muted">token <code>${escapeHtml(estado.miCaso.token.slice(0, 8))}…</code> · ` +
    `el servidor renueva el bloqueo solo</span>` +
    `<div class="row">` +
    `<button type="button" data-accion="liberar-mio">Liberar</button>` +
    `<button type="button" data-accion="completar-mio">Completar</button>` +
    `</div>`;
}

function pintarLog(estado, refs) {
  refs.log.innerHTML = estado.log
    .map(
      (e) =>
        `<li class="${e.clase}"><time>${e.hora.toLocaleTimeString('es-CO')}</time>${escapeHtml(e.texto)}</li>`,
    )
    .join('');
}

export function pintarCola(estado, refs, filtros) {
  const filas = filtrarCola(estado.cola, { ...filtros, yo: estado.auditor });
  if (filas.length === 0) {
    refs.tbodyCola.innerHTML = '<tr><td colspan="7" class="muted">Sin actas para este filtro.</td></tr>';
    return;
  }
  refs.tbodyCola.innerHTML = filas
    .map((c) => {
      const { puesto, mesa } = formatearActa(c.acta);
      const esMia = c.asignada_a === estado.auditor;
      const clase = esMia ? 'mia' : c.asignada_a ? 'asignada' : 'libre';
      const etiqueta = esMia ? 'mía' : c.asignada_a ? 'asignada' : 'disponible';
      const puedoTomar = !c.asignada_a && !estado.miCaso;
      return `<tr>
        <td><code>${escapeHtml(c.acta)}</code></td>
        <td>${escapeHtml(puesto)}</td><td>${escapeHtml(mesa)}</td>
        <td>${Number(c.prioridad)}</td>
        <td><span class="pill ${clase}">${etiqueta}</span></td>
        <td>${c.asignada_a ? escapeHtml(c.asignada_a) : '—'}</td>
        <td>
          <button type="button" class="mini" data-accion="tomar" data-acta="${escapeHtml(c.acta)}" ${puedoTomar ? '' : 'disabled'}>Tomar</button>
          ${esMia ? `<button type="button" class="mini sec" data-accion="liberar" data-acta="${escapeHtml(c.acta)}">Liberar</button>
          <button type="button" class="mini sec" data-accion="completar" data-acta="${escapeHtml(c.acta)}">Completar</button>` : ''}
        </td>
      </tr>`;
    })
    .join('');
}

export function pintarPresencia(estado, refs) {
  const lista = [...estado.conocidos.entries()]
    .map(([auditor, info]) => ({ auditor, ...info }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.auditor.localeCompare(b.auditor));
  if (lista.length === 0) {
    refs.tbodyPresencia.innerHTML = '<tr><td colspan="5" class="muted">Sin datos de presencia.</td></tr>';
    return;
  }
  refs.tbodyPresencia.innerHTML = lista
    .map((p) => {
      const r = p.registro ?? {};
      return `<tr>
        <td><code>${escapeHtml(p.auditor)}</code></td>
        <td><span class="pill ${p.online ? 'libre' : 'asignada'}">${p.online ? 'en línea' : 'desconectado'}</span></td>
        <td>${r.acta_actual ? `<code>${escapeHtml(r.acta_actual)}</code>` : '—'}</td>
        <td>${escapeHtml(r.instancia ?? 'n/d')}</td>
        <td>${haceCuanto(r.latido)}</td>
      </tr>`;
    })
    .join('');
}

export function toast(contenedor, texto, tipo = '') {
  const el = document.createElement('div');
  el.className = `toast ${tipo}`.trim();
  el.textContent = texto;
  contenedor.append(el);
  setTimeout(() => el.remove(), 6000);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

export const MENSAJES_ERROR = {
  falta_auditor: 'Falta el ID de auditor.',
  ya_tienes_caso: 'Ya tienes un caso tomado. Libéralo o complétalo antes.',
  peticion_invalida: 'Petición inválida.',
  operacion_fallida: 'El servidor no pudo completar la operación (¿Redis caído?).',
  mensaje_muy_grande: 'Mensaje demasiado grande.',
  json_invalido: 'Mensaje mal formado.',
  tipo_desconocido: 'Tipo de mensaje desconocido.',
};

// Página pública de resultados: un tópico a la vez (dep/mun/pue/mesa),
// renderizado SOLO con lo que envía el backend (snapshot Acumulado + stream_id).
// Sin recargas: el SSE actualiza en vivo.
import { crearClienteSSE, urlPorDefecto } from './sse.js';

const $ = (id) => document.getElementById(id);
const refs = {
  badge: $('badge-conexion'),
  actualizada: $('actualizada'),
  instancia: $('instancia'),
  resumen: $('resumen'),
  barras: $('barras'),
  tabla: $('tbody-resultados'),
  nivel: $('f-nivel'),
  id: $('f-id'),
  wrapId: $('wrap-id'),
};

let estado = { topico: 'dep', acumulado: null, ultima: null };

const cliente = crearClienteSSE({
  onEstado: (e) => {
    refs.badge.className = 'badge ' + (e === 'conectada' ? 'on' : 'mid');
    refs.badge.textContent = e === 'conectada' ? 'en vivo' : 'reconectando…';
  },
  onSnapshot: (foto, id) => {
    const acum = foto?.niveles?.[estado.topico];
    if (!acum) return;
    estado = { ...estado, acumulado: acum, ultima: new Date() };
    pintar(foto.instancia ?? null);
  },
  onEvento: (tipo, datos) => {
    // Deltas futuros de P2: si traen el acumulado del tópico, fusionar.
    const acum = datos?.niveles?.[estado.topico] ?? (datos?.nivel ? datos : null);
    if (acum && acum.nivel) {
      estado = { ...estado, acumulado: acum, ultima: new Date() };
      pintar(null);
    }
  },
});

function esCandidato(k) {
  return /^C\d+$/.test(k);
}

function pintar(instancia) {
  const a = estado.acumulado;
  if (!a) return;
  if (instancia) refs.instancia.textContent = `instancia ${instancia}`;
  refs.actualizada.textContent = `Última actualización: ${estado.ultima?.toLocaleTimeString('es-CO') ?? '—'}`;

  const entradas = Object.entries(a.votos ?? {});
  const cands = entradas.filter(([k]) => esCandidato(k)).sort((x, y) => y[1] - x[1]);
  const otros = entradas.filter(([k]) => !esCandidato(k)).sort((x, y) => y[1] - x[1]);
  const total = cands.reduce((s, [, v]) => s + v, 0);

  refs.resumen.innerHTML = `
    <article class="card"><span class="num">${fmt(total)}</span><span class="lbl">Votos por candidatos</span></article>
    <article class="card"><span class="num">${fmt(a.sufragantes)}</span><span class="lbl">Sufragantes</span></article>
    <article class="card"><span class="num">${fmt(a.mesas_informadas)} / ${fmt(a.mesas_totales)}</span><span class="lbl">Mesas informadas</span></article>
    <article class="card"><span class="num">${num(a.porcentaje_informado)}%</span><span class="lbl">Avance del preconteo</span></article>`;

  refs.barras.innerHTML =
    cands
      .map(([k, v]) => {
        const pct = a.sufragantes ? (v / a.sufragantes) * 100 : 0;
        return `<div class="cand"><div class="cand-head"><strong>${esc(k)}</strong><span>${fmt(v)} · ${num(pct)}%</span></div>
          <div class="barra"><div style="width:${pct.toFixed(2)}%"></div></div></div>`;
      })
      .join('') ||
    '<p class="muted">Sin votos de candidatos todavía.</p>';

  refs.tabla.innerHTML = [...cands, ...otros]
    .map(
      ([k, v]) =>
        `<tr><td><code>${esc(k)}</code></td><td class="der">${fmt(v)}</td>` +
        `<td class="der">${num(a.sufragantes ? (v / a.sufragantes) * 100 : 0)}%</td></tr>`,
    )
    .join('');
}

function fmt(n) {
  return Number(n ?? 0).toLocaleString('es-CO');
}
function num(n) {
  return (Math.round(Number(n ?? 0) * 100) / 100).toLocaleString('es-CO', { maximumFractionDigits: 2 });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function topicoDe(nivel, id) {
  return nivel === 'dep' ? 'dep' : `${nivel}:${id}`;
}

function aplicarFiltros() {
  const nivel = refs.nivel.value;
  const id = refs.id.value.trim();
  refs.wrapId.style.display = nivel === 'dep' ? 'none' : '';
  if (nivel !== 'dep' && !id) return null;
  return topicoDe(nivel, id);
}

refs.nivel.addEventListener('change', () => {
  refs.wrapId.style.display = refs.nivel.value === 'dep' ? 'none' : '';
});
$('f-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const t = aplicarFiltros();
  if (!t) return;
  estado = { topico: t, acumulado: null, ultima: null };
  refs.barras.innerHTML = '<p class="muted">Cargando…</p>';
  cliente.conectar(t, null, urlPorDefecto);
});
$('btn-reconectar').addEventListener('click', () => {
  cliente.conectar(estado.topico, cliente.ultimoId(), urlPorDefecto);
});

// Tópico inicial (?topico=mun:11).
const params = new URLSearchParams(location.search);
const inicial = params.get('topico') ?? 'dep';
{
  const m = /^(mun|pue|mesa):(.+)$/.exec(inicial);
  if (m) {
    refs.nivel.value = m[1];
    refs.id.value = m[2];
    refs.wrapId.style.display = '';
  }
  const t = aplicarFiltros();
  estado = { topico: t ?? 'dep', acumulado: null, ultima: null };
  cliente.conectar(estado.topico, null, urlPorDefecto);
}

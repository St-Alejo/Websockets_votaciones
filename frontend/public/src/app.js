import { createSseClient, defaultUrl } from './sse.js';

const $ = (id) => document.getElementById(id);
const refs = {
  badge: $('connection-badge'),
  updated: $('updated'),
  instance: $('instance'),
  summary: $('summary'),
  bars: $('bars'),
  table: $('results-tbody'),
  level: $('f-level'),
  id: $('f-id'),
  idWrap: $('id-wrap'),
};

let state = { topic: 'dept', totals: null, lastUpdate: null };

const client = createSseClient({
  onStatus: (s) => {
    refs.badge.className = 'badge ' + (s === 'connected' ? 'on' : 'mid');
    refs.badge.textContent = s === 'connected' ? 'live' : 'reconnecting…';
  },
  onSnapshot: (snap) => {
    const totals = snap?.levels?.[state.topic];
    if (!totals) return;
    state = { ...state, totals, lastUpdate: new Date() };
    render(snap.instance ?? null);
  },
  onEvent: (type, data) => {
    const totals = data?.levels?.[state.topic] ?? (data?.level ? data : null);
    if (totals && totals.level) {
      state = { ...state, totals, lastUpdate: new Date() };
      render(null);
    }
  },
});

function isCandidate(k) {
  return /^C\d+$/.test(k);
}

function render(instance) {
  const a = state.totals;
  if (!a) return;
  if (instance) refs.instance.textContent = `instance ${instance}`;
  refs.updated.textContent = `Last update: ${state.lastUpdate?.toLocaleTimeString('en-US') ?? '—'}`;

  const entries = Object.entries(a.votes ?? {});
  const cands = entries.filter(([k]) => isCandidate(k)).sort((x, y) => y[1] - x[1]);
  const others = entries.filter(([k]) => !isCandidate(k)).sort((x, y) => y[1] - x[1]);
  const total = cands.reduce((s, [, v]) => s + v, 0);

  refs.summary.innerHTML = `
    <article class="card"><span class="num">${fmt(total)}</span><span class="lbl">Votes for candidates</span></article>
    <article class="card"><span class="num">${fmt(a.voters)}</span><span class="lbl">Voters</span></article>
    <article class="card"><span class="num">${fmt(a.tables_reported)} / ${fmt(a.tables_total)}</span><span class="lbl">Tables reported</span></article>
    <article class="card"><span class="num">${num(a.percent_reported)}%</span><span class="lbl">Quick count progress</span></article>`;

  refs.bars.innerHTML =
    cands
      .map(([k, v]) => {
        const pct = a.voters ? (v / a.voters) * 100 : 0;
        return `<div class="cand"><div class="cand-head"><strong>${esc(k)}</strong><span>${fmt(v)} · ${num(pct)}%</span></div>
          <div class="bar"><div style="width:${pct.toFixed(2)}%"></div></div></div>`;
      })
      .join('') ||
    '<p class="muted">No candidate votes yet.</p>';

  refs.table.innerHTML = [...cands, ...others]
    .map(
      ([k, v]) =>
        `<tr><td><code>${esc(k)}</code></td><td class="right">${fmt(v)}</td>` +
        `<td class="right">${num(a.voters ? (v / a.voters) * 100 : 0)}%</td></tr>`,
    )
    .join('');
}

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}
function num(n) {
  return (Math.round(Number(n ?? 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
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

function topicOf(level, id) {
  return level === 'dept' ? 'dept' : `${level}:${id}`;
}

function applyFilters() {
  const level = refs.level.value;
  const id = refs.id.value.trim();
  refs.idWrap.style.display = level === 'dept' ? 'none' : '';
  if (level !== 'dept' && !id) return null;
  return topicOf(level, id);
}

refs.level.addEventListener('change', () => {
  refs.idWrap.style.display = refs.level.value === 'dept' ? 'none' : '';
});
$('f-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const t = applyFilters();
  if (!t) return;
  state = { topic: t, totals: null, lastUpdate: null };
  refs.bars.innerHTML = '<p class="muted">Loading…</p>';
  client.connect(t, null, defaultUrl);
});
$('btn-reconnect').addEventListener('click', () => {
  client.connect(state.topic, client.lastId(), defaultUrl);
});

const params = new URLSearchParams(location.search);
const initial = params.get('topic') ?? 'dept';
{
  const m = /^(mun|station|table):(.+)$/.exec(initial);
  if (m) {
    refs.level.value = m[1];
    refs.id.value = m[2];
    refs.idWrap.style.display = '';
  }
  const t = applyFilters();
  state = { topic: t ?? 'dept', totals: null, lastUpdate: null };
  client.connect(state.topic, null, defaultUrl);
}

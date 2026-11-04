import { createOfflineQueue } from './offlineQueue.js';
import { createIdbStorage } from './idb.js';
import { createJurorClient, defaultUrl } from './ws.js';

const $ = (id) => document.getElementById(id);
const CANDIDATES = ['C1', 'C2', 'C3', 'C4'];

const refs = {
  badge: $('connection-badge'),
  idbWarning: $('idb-warning'),
  sum: $('sum'),
  history: $('history'),
  toasts: $('toasts'),
};

const storage = createIdbStorage();
if (!storage.persistent) {
  refs.idbWarning.hidden = false;
}
const queue = createOfflineQueue({ storage });
const client = createJurorClient({
  onStatus: renderStatus,
  onUnexpectedResponse: (msg) => toast(`Unexpected response: ${JSON.stringify(msg)}`, 'warn'),
});

let juror = null;
let wsUrl = null;

function renderStatus(s) {
  refs.badge.className = 'badge ' + (s === 'connected' ? 'on' : s === 'disconnected' ? 'off' : 'mid');
  refs.badge.textContent = s === 'connected' ? 'connected' : s === 'disconnected' ? 'offline' : 'connecting…';
  if (s === 'connected') pump();
}

function toast(text, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = text;
  refs.toasts.append(el);
  setTimeout(() => el.remove(), 6000);
}

function pump() {
  queue.process({
    canSend: () => client.connected() && navigator.onLine !== false,
    send: (submission) => client.sendTally(submission.tally),
  }).catch(() => {});
}

async function renderHistory() {
  const submissions = await queue.list();
  if (submissions.length === 0) {
    refs.history.innerHTML = '<li class="muted">No transmissions yet.</li>';
    return;
  }
  refs.history.innerHTML = submissions
    .slice()
    .reverse()
    .map((e) => {
      const r = e.response ? ` · server: <strong>${esc(e.response.status)}</strong>` : '';
      const err = e.lastError ? ` · ${esc(e.lastError)}` : '';
      const detail = e.response ? `<br><span class="muted">receipt <code>${esc(e.response.receipt ?? '—')}</code></span>` : '';
      const btn = e.status === 'FAILED' ? ` <button type="button" data-retry="${esc(e.id)}">Retry</button>` : '';
      return `<li><span class="pill ${e.status.toLowerCase()}">${e.status}</span>
        <code>${esc(e.tally.tally)}</code> v${e.tally.version} · attempts ${e.attempts}${r}${err}${detail}${btn}</li>`;
    })
    .join('');
}
queue.subscribe(renderHistory);

refs.history.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-retry]');
  if (!btn) return;
  await queue.retry(btn.dataset.retry);
  pump();
});

function readInt(id) {
  const v = $(id).value.trim();
  if (!/^\d+$/.test(v)) return null;
  return Number(v);
}

function readForm() {
  const votes = {};
  for (const c of CANDIDATES) {
    const v = readInt(`v-${c}`);
    if (v === null) return { error: `Invalid votes for ${c} (integer ≥ 0).` };
    votes[c] = v;
  }
  for (const k of ['BLANK', 'NULL', 'UNMARKED']) {
    const v = readInt(`v-${k}`);
    if (v === null) return { error: `Invalid votes for ${k} (integer ≥ 0).` };
    votes[k] = v;
  }
  const voters = readInt('voters');
  if (voters === null) return { error: 'Invalid voters.' };
  const table = readInt('table');
  const station = readInt('station');
  const municipality = readInt('municipality');
  const corp = readInt('corp');
  const version = readInt('version');
  if ([table, station, municipality, corp, version].some((x) => x === null || x <= 0)) {
    return { error: 'Table, station, municipality, corporation and version must be integers ≥ 1.' };
  }
  const tally = {
    tally: `E14-${station}-${table}-${corp}`,
    table,
    station,
    municipality,
    version,
    juror,
    closed_at: Math.floor(Date.now() / 1000),
    votes,
    voters,
    photo_hash: $('hash').value.trim() || 'no-photo',
    idem: crypto.randomUUID(),
  };
  return { tally };
}

function updateSum() {
  let sum = 0;
  let ok = true;
  for (const c of [...CANDIDATES, 'BLANK', 'NULL', 'UNMARKED']) {
    const v = readInt(`v-${c}`);
    if (v === null) {
      ok = false;
      break;
    }
    sum += v;
  }
  const vot = readInt('voters');
  refs.sum.textContent =
    !ok || vot === null ? '—' : sum === vot ? `✓ ${sum} = ${vot}` : `⚠ ${sum} ≠ ${vot} (will be doubtful)`;
}

document.querySelectorAll('#tally-form input').forEach((i) => i.addEventListener('input', updateSum));

$('tally-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const { tally, error } = readForm();
  if (error) {
    toast(error, 'bad');
    return;
  }
  const submission = await queue.save(tally);
  toast(`Tally ${tally.tally} saved (${submission.idem.slice(0, 8)}…). It will be sent when there is a connection.`);
  ev.target.reset();
  $('version').value = '1';
  updateSum();
  pump();
});

window.addEventListener('online', () => {
  toast('Connection restored. Retrying submissions…');
  pump();
});
window.addEventListener('offline', () => toast('Offline. Submissions stay queued.', 'warn'));

const params = new URLSearchParams(location.search);
if (params.get('juror')) $('login-juror').value = params.get('juror');

$('login-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  juror = $('login-juror').value.trim();
  if (!juror) {
    toast('Enter your juror ID.', 'bad');
    return;
  }
  wsUrl = $('login-ws').value.trim() || defaultUrl(juror);
  $('juror-chip').textContent = juror;
  $('login').hidden = true;
  $('app').hidden = false;
  client.connect(wsUrl);
  renderHistory();
  pump();
});

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

import { createStore } from './store.js';
import { createWsClient, defaultUrl } from './ws.js';
import {
  ERROR_MESSAGES,
  escapeHtml,
  render,
  renderQueue,
  renderPresence,
  toast,
} from './ui.js';

const $ = (id) => document.getElementById(id);
const store = createStore();
const refs = {
  badge: $('connection-badge'),
  stPending: $('st-pending'),
  stAssigned: $('st-assigned'),
  stResolved: $('st-resolved'),
  stOnline: $('st-online'),
  stOffline: $('st-offline'),
  myCase: $('my-case'),
  log: $('log'),
  tbodyQueue: $('tbody-queue'),
  tbodyPresence: $('tbody-presence'),
  toasts: $('toasts'),
};

const filters = { text: '', status: 'all', minPrio: '' };
function rerender() {
  render(store.state, refs);
  renderQueue(store.state, refs, filters);
  renderPresence(store.state, refs);
}
store.subscribe(rerender);
setInterval(() => renderPresence(store.state, refs), 10_000);

const client = createWsClient({
  getCurrentTally: () => store.state.myCase?.tally ?? null,
  onStatus: (s) => {
    store.update({ connected: s === 'connected' ? true : s === 'disconnected' ? 'x' : 'c' });
  },
  onOpen: () => {
    client.send({ type: 'heartbeat', tally: store.state.myCase?.tally ?? null });
    store.addLog('Connection established with the server.');
  },
  onMessage: (msg) => onReceive(msg),
});

function onReceive(msg) {
  const e = store.state;
  switch (msg.type) {
    case 'hello':
      store.update({ instance: msg.instance, queue: msg.queue ?? [], present: msg.present ?? [] });
      store.markSeen(msg.present ?? []);
      $('subtitle').textContent = `Instance ${msg.instance} · ${msg.queue?.length ?? 0} tallies in queue`;
      store.addLog(`Hello from ${msg.instance}: ${msg.queue?.length ?? 0} tallies, ${msg.present?.length ?? 0} online.`);
      break;
    case 'heartbeat_ok':
      break;
    case 'case':
      if (!msg.case) {
        toast(refs.toasts, 'Queue empty or everything taken. Try again in a few seconds.');
      } else {
        store.update({ myCase: msg.case });
        store.addLog(`You took ${msg.case.tally} (token ${msg.case.token.slice(0, 8)}…).`, 'e-assigned');
        toast(refs.toasts, `Case assigned: ${msg.case.tally}`);
      }
      break;
    case 'released':
      if (msg.ok) {
        if (e.myCase?.tally === msg.tally) store.update({ myCase: null });
        store.addLog(`You released ${msg.tally}.`, 'e-released');
      } else {
        toast(refs.toasts, `Could not release ${msg.tally}: the lock is no longer yours.`, 'warn');
      }
      break;
    case 'completed':
      if (msg.ok) {
        if (e.myCase?.tally === msg.tally) store.update({ myCase: null });
        store.update({ resolvedThisSession: e.resolvedThisSession + 1 });
        store.addLog(`You completed ${msg.tally}.`, 'e-resolved');
        toast(refs.toasts, `Tally resolved: ${msg.tally}`);
      } else {
        toast(refs.toasts, `Could not complete ${msg.tally}: the lock is no longer yours.`, 'warn');
      }
      break;
    case 'lock_lost':
      store.update({ myCase: null });
      store.addLog(`You lost the lock on ${msg.tally} (another auditor took it).`, 'e-released');
      toast(refs.toasts, `Lock lost: ${msg.tally}`, 'warn');
      break;
    case 'queue':
      store.update({ queue: msg.queue ?? [] });
      if (msg.event) {
        const ev = msg.event;
        const who = ev.auditor ? ` by ${escapeHtml(ev.auditor)}` : '';
        store.addLog(`Tally ${ev.tally}: ${ev.type}${who}.`, `e-${ev.type}`);
      }
      break;
    case 'present':
      store.update({ present: msg.present ?? [] });
      store.markSeen(msg.present ?? []);
      if (msg.event) store.markPresenceEvent(msg.event);
      break;
    case 'error':
      toast(refs.toasts, ERROR_MESSAGES[msg.reason] ?? `Error: ${msg.reason}`, 'bad');
      break;
    default:
      break;
  }
}

document.querySelector('.main').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const myCase = store.state.myCase;
  if (action === 'take') {
    client.send({ type: 'take' });
  } else if ((action === 'release' || action === 'release-mine') && myCase) {
    client.send({ type: 'release', tally: myCase.tally, token: myCase.token });
  } else if ((action === 'complete' || action === 'complete-mine') && myCase) {
    if (confirm(`Mark ${myCase.tally} as verified and remove it from the queue?`)) {
      client.send({ type: 'complete', tally: myCase.tally, token: myCase.token });
    }
  }
});

$('f-text').addEventListener('input', (ev) => {
  filters.text = ev.target.value;
  renderQueue(store.state, refs, filters);
});
$('f-status').addEventListener('change', (ev) => {
  filters.status = ev.target.value;
  renderQueue(store.state, refs, filters);
});
$('f-prio').addEventListener('input', (ev) => {
  filters.minPrio = ev.target.value;
  renderQueue(store.state, refs, filters);
});
$('btn-refresh').addEventListener('click', () => client.send({ type: 'queue' }));
$('btn-presence').addEventListener('click', () => client.send({ type: 'present' }));
$('btn-exit').addEventListener('click', () => {
  client.close();
  location.reload();
});

const params = new URLSearchParams(location.search);
if (params.get('auditor')) $('login-auditor').value = params.get('auditor');
if (params.get('ws')) $('login-ws').value = params.get('ws');

$('login-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const auditor = $('login-auditor').value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(auditor)) {
    toast(refs.toasts, 'Invalid ID: use letters, digits, _ or - (max. 64).', 'bad');
    return;
  }
  const wsUrl = $('login-ws').value.trim() || defaultUrl(auditor);
  store.update({ auditor });
  $('auditor-chip').textContent = auditor;
  $('login').hidden = true;
  $('app').hidden = false;
  client.connect(wsUrl);
});

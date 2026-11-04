export function formatTally(id) {
  const m = /^E14-(\d+)-(\d+)-(\d+)$/.exec(id ?? '');
  if (!m) return { station: 'n/a', table: 'n/a' };
  return { station: m[1], table: m[2] };
}

export function timeAgo(ms) {
  if (!ms) return 'n/a';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}min ago`;
}

export function filterQueue(queue, { text, status, minPrio, me }) {
  return queue.filter((c) => {
    if (text && !c.tally.toLowerCase().includes(text.toLowerCase())) return false;
    if (minPrio !== '' && Number(c.priority) < Number(minPrio)) return false;
    const assigned = !!c.assigned_to;
    if (status === 'free' && assigned) return false;
    if (status === 'assigned' && !assigned) return false;
    if (status === 'mine' && c.assigned_to !== me) return false;
    return true;
  });
}

export function render(state, refs) {
  const free = state.queue.filter((c) => !c.assigned_to).length;
  refs.stPending.textContent = free;
  refs.stAssigned.textContent = state.queue.length - free;
  refs.stResolved.textContent = state.resolvedThisSession;
  const online = [...state.known.values()].filter((c) => c.online).length;
  refs.stOnline.textContent = online;
  refs.stOffline.textContent = state.known.size - online;

  const badge = refs.badge;
  badge.className = 'badge ' + (state.connected === true ? 'on' : state.connected === 'x' ? 'off' : 'mid');
  badge.textContent = state.connected === true ? 'connected' : state.connected === 'x' ? 'disconnected' : 'connecting…';

  renderMyCase(state, refs);
  renderLog(state, refs);
}

function renderMyCase(state, refs) {
  const el = refs.myCase;
  if (!state.myCase) {
    el.innerHTML = 'No case assigned.';
    return;
  }
  el.innerHTML =
    `<strong>${escapeHtml(state.myCase.tally)}</strong><br>` +
    `<span class="muted">token <code>${escapeHtml(state.myCase.token.slice(0, 8))}…</code> · ` +
    `the server renews the lock automatically</span>` +
    `<div class="row">` +
    `<button type="button" data-action="release-mine">Release</button>` +
    `<button type="button" data-action="complete-mine">Complete</button>` +
    `</div>`;
}

function renderLog(state, refs) {
  refs.log.innerHTML = state.log
    .map(
      (e) =>
        `<li class="${e.cssClass}"><time>${e.time.toLocaleTimeString('en-US')}</time>${escapeHtml(e.text)}</li>`,
    )
    .join('');
}

export function renderQueue(state, refs, filters) {
  const rows = filterQueue(state.queue, { ...filters, me: state.auditor });
  if (rows.length === 0) {
    refs.tbodyQueue.innerHTML = '<tr><td colspan="7" class="muted">No tallies for this filter.</td></tr>';
    return;
  }
  refs.tbodyQueue.innerHTML = rows
    .map((c) => {
      const { station, table } = formatTally(c.tally);
      const isMine = c.assigned_to === state.auditor;
      const cssClass = isMine ? 'mine' : c.assigned_to ? 'assigned' : 'free';
      const label = isMine ? 'mine' : c.assigned_to ? 'assigned' : 'available';
      const canTake = !c.assigned_to && !state.myCase;
      return `<tr>
        <td><code>${escapeHtml(c.tally)}</code></td>
        <td>${escapeHtml(station)}</td><td>${escapeHtml(table)}</td>
        <td>${Number(c.priority)}</td>
        <td><span class="pill ${cssClass}">${label}</span></td>
        <td>${c.assigned_to ? escapeHtml(c.assigned_to) : '—'}</td>
        <td>
          <button type="button" class="mini" data-action="take" data-tally="${escapeHtml(c.tally)}" ${canTake ? '' : 'disabled'}>Take</button>
          ${isMine ? `<button type="button" class="mini sec" data-action="release" data-tally="${escapeHtml(c.tally)}">Release</button>
          <button type="button" class="mini sec" data-action="complete" data-tally="${escapeHtml(c.tally)}">Complete</button>` : ''}
        </td>
      </tr>`;
    })
    .join('');
}

export function renderPresence(state, refs) {
  const list = [...state.known.entries()]
    .map(([auditor, info]) => ({ auditor, ...info }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.auditor.localeCompare(b.auditor));
  if (list.length === 0) {
    refs.tbodyPresence.innerHTML = '<tr><td colspan="5" class="muted">No presence data.</td></tr>';
    return;
  }
  refs.tbodyPresence.innerHTML = list
    .map((p) => {
      const r = p.record ?? {};
      return `<tr>
        <td><code>${escapeHtml(p.auditor)}</code></td>
        <td><span class="pill ${p.online ? 'free' : 'assigned'}">${p.online ? 'online' : 'disconnected'}</span></td>
        <td>${r.current_tally ? `<code>${escapeHtml(r.current_tally)}</code>` : '—'}</td>
        <td>${escapeHtml(r.instance ?? 'n/a')}</td>
        <td>${timeAgo(r.heartbeat)}</td>
      </tr>`;
    })
    .join('');
}

export function toast(container, text, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = text;
  container.append(el);
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

export const ERROR_MESSAGES = {
  missing_auditor: 'Auditor ID is missing.',
  already_has_case: 'You already hold a case. Release or complete it first.',
  invalid_request: 'Invalid request.',
  operation_failed: 'The server could not complete the operation (is Redis down?).',
  message_too_large: 'Message too large.',
  invalid_json: 'Malformed message.',
  unknown_type: 'Unknown message type.',
};

import { getRedis } from '../redis/client.js';
import {
  active,
  updateTally as updateTallyTracker,
  updateStatus as updateStatusTracker,
  detectGhosts,
  heartbeat as heartbeatTracker,
  purgeExpired,
  leave as leaveTracker,
} from './tracker.js';

const connected = new Map();

function hasRedis() {
  try {
    const r = getRedis();
    return !!r && (!r.status || r.status === 'ready');
  } catch {
    return false;
  }
}

export async function heartbeat(auditor, { instance, current_tally = null }) {
  if (hasRedis()) {
    await heartbeatTracker(auditor, { instance, current_tally });
    return;
  }
  const previous = connected.get(auditor);
  connected.set(auditor, {
    auditor,
    status: 'online',
    instance,
    current_tally,
    since: previous?.since ?? Date.now(),
  });
}

export async function leave(auditor) {
  if (hasRedis()) {
    await leaveTracker(auditor);
    return;
  }
  connected.delete(auditor);
}

export async function presentAuditors() {
  if (hasRedis()) return active();
  return [...connected.values()];
}

export {
  updateTallyTracker as updateTally,
  updateStatusTracker as updateStatus,
  detectGhosts,
  purgeExpired,
};

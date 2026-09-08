import type { AgentSession, RelaySnapshot, SavedDevice } from './types';

export const FRESHNESS_MS = 40_000;
export const hostKey = (host: SavedDevice): string =>
  `${host.relayUrl.replace(/\/+$/, '')}|${host.deviceId}`;
export const taskKey = (host: SavedDevice, sessionRef: string): string =>
  `${hostKey(host)}|${sessionRef}`;

export interface HostSnapshot {
  host: SavedDevice;
  snapshot: RelaySnapshot | null;
  lastSuccessAt: number | null;
  error: string | null;
}

export function hostOnline(value: HostSnapshot, now = Date.now()): boolean {
  return !value.error && value.snapshot?.hub_online !== false && value.lastSuccessAt !== null &&
    now - value.lastSuccessAt < FRESHNESS_MS;
}

const priority: Partial<Record<AgentSession['state'], number>> = {
  needs_you: 100, failed: 90, interrupted: 80,
  completed: 70, turn_finished: 60, subtask_completed: 50, working: 10,
};

export function fleetTasks(hosts: HostSnapshot[], now = Date.now()) {
  return hosts.flatMap((entry) => (entry.snapshot?.sessions ?? []).map((session) => ({
    key: taskKey(entry.host, session.session_ref), host: entry.host, session,
    online: hostOnline(entry, now),
    attention: !session.acknowledged_at && (priority[session.state] ?? 0) >= 50,
  }))).sort((a, b) =>
    Number(b.online) - Number(a.online) ||
    (priority[b.session.state] ?? 0) - (priority[a.session.state] ?? 0) ||
    b.session.updated_at.localeCompare(a.session.updated_at) || a.key.localeCompare(b.key));
}

// Every host progresses independently; an unreachable host never holds up
// successful snapshots. Each host has at most one read in flight.
export function createFleetPoller(
  read: (host: SavedDevice) => Promise<RelaySnapshot>,
  onChange: (entries: HostSnapshot[]) => void,
  now = () => Date.now(),
) {
  const entries = new Map<string, HostSnapshot>();
  const inFlight = new Map<string, Promise<void>>();
  let closed = false;
  function setHosts(hosts: SavedDevice[]) {
    const keys = new Set(hosts.map(hostKey));
    for (const key of entries.keys()) if (!keys.has(key)) entries.delete(key);
    for (const host of hosts) {
      const key = hostKey(host);
      const existing = entries.get(key);
      if (existing && existing.host.deviceSecret === host.deviceSecret) existing.host = host;
      else entries.set(key, { host, snapshot: null, lastSuccessAt: null, error: null });
    }
    if (!closed) onChange([...entries.values()]);
  }
  async function refresh(onlyHost?: SavedDevice): Promise<void> {
    if (closed) return;
    await Promise.all([...entries].map(([key, entry]) => {
      if (onlyHost && key !== hostKey(onlyHost)) return;
      if (inFlight.has(key)) return inFlight.get(key);
      const request = (async () => {
        try {
          const snapshot = await read(entry.host);
          if (closed || entries.get(key) !== entry) return;
          entry.snapshot = snapshot;
          entry.lastSuccessAt = now();
          entry.error = null;
        } catch (error) {
          if (closed || entries.get(key) !== entry) return;
          entry.error = error instanceof Error ? error.message : '无法连接电脑';
        } finally {
          if (!closed && entries.get(key) === entry) onChange([...entries.values()]);
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, request);
      return request;
    }));
  }
  return { setHosts, refresh, markError(host: SavedDevice, error: Error) {
    const entry = entries.get(hostKey(host));
    if (!closed && entry) { entry.error = error.message; onChange([...entries.values()]); }
  }, close() { closed = true; entries.clear(); } };
}

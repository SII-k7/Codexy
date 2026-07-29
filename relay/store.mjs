import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { normalizeDevicePreferences } from './notifications.mjs';

const STORE_VERSION = 1;
const MAX_EVENTS_PER_DEVICE = 100;
const MAX_WEB_PUSH_SUBSCRIPTIONS = 8;
const MAX_AGENT_SESSIONS = 16;
const MAX_PROMPTS_PER_SESSION = 10;

function emptyStore() {
  return {
    devices: new Map(),
    hookTokens: new Map(),
  };
}

function storedString(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function restoreSubscription(value) {
  if (!value || typeof value !== 'object') return null;
  const endpoint = storedString(value.endpoint, 2048);
  const p256dh = storedString(value.keys?.p256dh, 256);
  const auth = storedString(value.keys?.auth, 256);
  if (!endpoint.startsWith('https://') || !p256dh || !auth) return null;
  return {
    endpoint,
    expirationTime:
      typeof value.expirationTime === 'number' ? value.expirationTime : null,
    keys: { p256dh, auth },
  };
}

function restorePrompt(value) {
  if (!value || typeof value !== 'object') return null;
  const promptId = storedString(value.prompt_id, 128);
  const capturedAt = storedString(value.captured_at, 64);
  const text = storedString(value.text, 2_000);
  if (!promptId || !capturedAt || !text) return null;
  return {
    prompt_id: promptId,
    captured_at: capturedAt,
    text,
  };
}

function restoreAgentSession(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.source !== 'codex') return null;
  const sessionRef = storedString(value.session_ref, 80);
  if (!/^sha256:[a-f0-9]{16,64}$/i.test(sessionRef)) return null;
  const prompts = Array.isArray(value.prompts)
    ? value.prompts
        .map(restorePrompt)
        .filter(Boolean)
        .slice(-MAX_PROMPTS_PER_SESSION)
    : [];
  return {
    session_ref: sessionRef,
    source: 'codex',
    project_alias: storedString(value.project_alias, 64) || 'Codex project',
    state: storedString(value.state, 40) || 'working',
    summary: storedString(value.summary, 160) || 'Codex session updated',
    updated_at: storedString(value.updated_at, 64) || new Date(0).toISOString(),
    last_event_at: storedString(value.last_event_at, 64) || null,
    acknowledged_at: storedString(value.acknowledged_at, 64) || null,
    prompts,
  };
}

function restoreAgentSessions(value, events) {
  const sessions = Array.isArray(value)
    ? value
        .map(restoreAgentSession)
        .filter(Boolean)
        .slice(-MAX_AGENT_SESSIONS)
    : [];
  const byRef = new Map(sessions.map((session) => [session.session_ref, session]));

  for (const event of events) {
    if (event.source !== 'codex') continue;
    const sessionRef = storedString(event.session_ref, 80);
    if (!/^sha256:[a-f0-9]{16,64}$/i.test(sessionRef)) continue;
    const existing = byRef.get(sessionRef);
    const occurredAt =
      storedString(event.occurred_at, 64) || new Date(0).toISOString();
    if (!existing) {
      const session = {
        session_ref: sessionRef,
        source: 'codex',
        project_alias:
          storedString(event.project_alias, 64) || 'Codex project',
        state: storedString(event.state, 40) || 'working',
        summary: storedString(event.summary, 160) || 'Codex session updated',
        updated_at: occurredAt,
        last_event_at: occurredAt,
        acknowledged_at:
          storedString(event.acknowledged_at, 64) || null,
        prompts: [],
      };
      sessions.push(session);
      byRef.set(sessionRef, session);
      continue;
    }
    if (Date.parse(occurredAt) >= Date.parse(existing.updated_at)) {
      existing.source = 'codex';
      existing.project_alias =
        storedString(event.project_alias, 64) || existing.project_alias;
      existing.state = storedString(event.state, 40) || existing.state;
      existing.summary = storedString(event.summary, 160) || existing.summary;
      existing.updated_at = occurredAt;
      existing.last_event_at = occurredAt;
      existing.acknowledged_at =
        storedString(event.acknowledged_at, 64) || null;
    }
  }

  return sessions
    .sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at))
    .slice(-MAX_AGENT_SESSIONS);
}

function restoreDevice(value) {
  if (!value || typeof value !== 'object') return null;
  const deviceId = storedString(value.deviceId, 128);
  const deviceSecret = storedString(value.deviceSecret, 256);
  if (!deviceId || !deviceSecret) return null;

  const events = Array.isArray(value.events)
    ? value.events
        .filter(
          (event) =>
            event &&
            typeof event === 'object' &&
            event.source === 'codex',
        )
        .slice(-MAX_EVENTS_PER_DEVICE)
    : [];
  const webPushSubscriptions = Array.isArray(value.webPushSubscriptions)
    ? value.webPushSubscriptions
        .map(restoreSubscription)
        .filter(Boolean)
        .slice(-MAX_WEB_PUSH_SUBSCRIPTIONS)
    : [];
  const agentSessions = restoreAgentSessions(value.agentSessions, events);

  return {
    deviceId,
    deviceSecret,
    expoPushToken: storedString(value.expoPushToken, 256) || null,
    platform: storedString(value.platform, 24) || 'unknown',
    pairingCode: storedString(value.pairingCode, 6) || null,
    pairingExpiresAt:
      typeof value.pairingExpiresAt === 'number'
        ? value.pairingExpiresAt
        : null,
    hookToken: storedString(value.hookToken, 256) || null,
    events,
    dedupeKeys: new Set(
      events
        .map((event) => storedString(event.dedupe_key, 128))
        .filter(Boolean),
    ),
    nextCursor:
      Number.isInteger(value.nextCursor) && value.nextCursor >= 0
        ? value.nextCursor
        : events.reduce(
            (highest, event) =>
              Number.isInteger(event.cursor)
                ? Math.max(highest, event.cursor)
                : highest,
            0,
          ),
    agentSessions,
    webPushSubscriptions,
    preferences: normalizeDevicePreferences(value.preferences),
  };
}

export function loadRelayStore(stateFile) {
  if (!stateFile) return emptyStore();
  const absolutePath = resolve(stateFile);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore();
    throw new Error(`could not read Relay state: ${error.message}`);
  }

  if (
    !parsed ||
    parsed.version !== STORE_VERSION ||
    !Array.isArray(parsed.devices)
  ) {
    throw new Error('Relay state file has an unsupported format');
  }

  const store = emptyStore();
  for (const value of parsed.devices) {
    const device = restoreDevice(value);
    if (!device) continue;
    store.devices.set(device.deviceId, device);
    if (device.hookToken) {
      store.hookTokens.set(device.hookToken, device.deviceId);
    }
  }
  return store;
}

export function persistRelayStore(stateFile, store) {
  if (!stateFile) return;
  const absolutePath = resolve(stateFile);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const devices = [...store.devices.values()].map((device) => ({
    deviceId: device.deviceId,
    deviceSecret: device.deviceSecret,
    expoPushToken: device.expoPushToken,
    platform: device.platform,
    pairingCode: device.pairingCode,
    pairingExpiresAt: device.pairingExpiresAt,
    hookToken: device.hookToken,
    events: device.events,
    nextCursor: device.nextCursor,
    agentSessions: device.agentSessions ?? [],
    webPushSubscriptions: device.webPushSubscriptions ?? [],
    preferences: normalizeDevicePreferences(device.preferences),
  }));
  writeFileSync(
    absolutePath,
    `${JSON.stringify({ version: STORE_VERSION, devices }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

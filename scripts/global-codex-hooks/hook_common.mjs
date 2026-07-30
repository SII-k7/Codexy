import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const MAX_STDIN_BYTES = 1_048_576;
export const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
export const WHITESPACE_RE = /\s+/g;

export function configured(primary, legacy = null) {
  return process.env[primary] || (legacy ? process.env[legacy] : null) || null;
}

function relayStatePath() {
  const configuredPath = configured(
    'CODEXY_RELAY_STATE_FILE',
    'ATTENTION_RELAY_STATE_FILE',
  );
  return configuredPath
    ? resolve(configuredPath)
    : join(homedir(), '.codex', 'codexy', 'relay-state.json');
}

export function relayToken() {
  const explicit = configured(
    'CODEXY_RELAY_TOKEN',
    'ATTENTION_RELAY_TOKEN',
  );
  if (explicit) return explicit;
  let value;
  try {
    value = JSON.parse(readFileSync(relayStatePath(), 'utf8'));
  } catch {
    return null;
  }
  const devices = Array.isArray(value?.devices) ? value.devices : [];
  const active = devices.find(
    (device) =>
      device?.deviceId === value?.activeDeviceId &&
      typeof device?.hookToken === 'string' &&
      device.hookToken,
  );
  if (active) return active.hookToken;
  const tokens = devices
    .map((device) => device?.hookToken)
    .filter((token) => typeof token === 'string' && token);
  return tokens.length === 1 ? tokens[0] : null;
}

export function readHookInput(argument = null) {
  const raw =
    typeof argument === 'string' && argument.trim().startsWith('{')
      ? Buffer.from(argument, 'utf8')
      : readFileSync(0);
  if (!raw.toString('utf8').trim()) {
    throw new Error('hook input is empty');
  }
  if (raw.byteLength > MAX_STDIN_BYTES) {
    throw new Error('hook input is larger than 1 MiB');
  }
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`hook input is not valid UTF-8 JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hook input must be one JSON object');
  }
  return value;
}

export function firstString(...values) {
  return values.find(
    (value) => typeof value === 'string' && value.length > 0,
  ) ?? null;
}

export function nested(value, ...keys) {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return null;
    current = current[key];
  }
  return current;
}

export function rawSessionId(hook) {
  const params =
    hook?.params && typeof hook.params === 'object' ? hook.params : {};
  return firstString(
    hook?.session_id,
    hook?.['thread-id'],
    hook?.threadId,
    params.threadId,
    nested(params, 'turn', 'threadId'),
  );
}

export function sessionReference(value) {
  return `sha256:${createHash('sha256')
    .update(value, 'utf8')
    .digest('hex')
    .slice(0, 24)}`;
}

function cleanAlias(value) {
  const normalized = String(value || 'Codex project')
    .normalize('NFKC')
    .replace(CONTROL_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim();
  return (normalized || 'Codex project').slice(0, 64);
}

export function projectAlias(hook) {
  const override = configured(
    'CODEXY_PROJECT_ALIAS',
    'ATTENTION_PROJECT_ALIAS',
  );
  if (override) return cleanAlias(override);
  if (typeof hook?.cwd !== 'string') return 'Codex project';
  const parts = hook.cwd
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  return cleanAlias(parts.at(-1));
}

export function validatedEndpoint(value, fallback) {
  const endpoint = value || fallback;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Relay URL is invalid');
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== 'https:' &&
      !(
        parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '::1'].includes(
          parsed.hostname.toLowerCase(),
        )
      ))
  ) {
    throw new Error(
      'Relay URL must use HTTPS except on loopback and contain no credentials',
    );
  }
  return parsed.href;
}

export async function postJson(endpoint, token, payload, userAgent) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Relay returned HTTP ${response.status}`);
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Relay request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runNonBlocking(label, action) {
  try {
    await action();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`codexy ${label} hook skipped: ${detail}`);
  }
}

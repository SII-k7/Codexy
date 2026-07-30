import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const state = process.argv[2] ?? 'needs_you';
const relayUrl =
  process.env.CODEXY_RELAY_URL ??
  process.env.ATTENTION_RELAY_URL ??
  'http://127.0.0.1:8797/v1/events';
function tokenFromLocalState() {
  const statePath =
    process.env.CODEXY_RELAY_STATE_FILE ??
    process.env.ATTENTION_RELAY_STATE_FILE ??
    join(homedir(), '.codex', 'codexy', 'relay-state.json');
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const tokens = (Array.isArray(state.devices) ? state.devices : [])
      .map((device) => device?.hookToken)
      .filter((candidate) => typeof candidate === 'string' && candidate);
    return tokens.length === 1 ? tokens[0] : null;
  } catch {
    return null;
  }
}

const token =
  process.env.CODEXY_RELAY_TOKEN ??
  process.env.ATTENTION_RELAY_TOKEN ??
  tokenFromLocalState();

if (!token) {
  console.error(
    'No single paired Codexy device was found. Pair the phone first or set CODEXY_RELAY_TOKEN.',
  );
  process.exit(1);
}

const projectAlias =
  process.env.CODEXY_PROJECT_ALIAS ??
  process.env.ATTENTION_PROJECT_ALIAS ??
  'Codexy demo';
const sessionRef =
  process.env.CODEXY_SESSION_REF ??
  `sha256:${createHash('sha256')
    .update(`codexy-demo:${projectAlias}`)
    .digest('hex')}`;
const eventId = randomUUID();
const response = await fetch(relayUrl, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    schema_version: '1.0',
    event_id: eventId,
    dedupe_key: `demo:${eventId}`,
    occurred_at: new Date().toISOString(),
    source: 'codex',
    state,
    event: 'Manual',
    project_alias: projectAlias,
    session_ref: sessionRef,
    summary:
      state === 'needs_you'
        ? '需要你确认：手机通知能否准确打开这条测试轨道？'
        : 'Codexy 测试会话状态已更新',
  }),
});

const result = await response.json();
if (!response.ok) {
  console.error(result.error ?? `HTTP ${response.status}`);
  process.exit(1);
}
console.log(JSON.stringify(result, null, 2));

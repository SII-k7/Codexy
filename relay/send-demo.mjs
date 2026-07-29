import { randomUUID } from 'node:crypto';

const state = process.argv[2] ?? 'needs_you';
const relayUrl =
  process.env.CODEXY_RELAY_URL ??
  process.env.ATTENTION_RELAY_URL ??
  'http://127.0.0.1:8797/v1/events';
const token =
  process.env.CODEXY_RELAY_TOKEN ??
  process.env.ATTENTION_RELAY_TOKEN;

if (!token) {
  console.error('CODEXY_RELAY_TOKEN is required. Claim a pairing code first.');
  process.exit(1);
}

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
    project_alias:
      process.env.CODEXY_PROJECT_ALIAS ??
      process.env.ATTENTION_PROJECT_ALIAS ??
      'Codexy demo',
    summary:
      state === 'needs_you'
        ? 'Agent needs your confirmation to continue'
        : 'Codex status changed',
  }),
});

const result = await response.json();
if (!response.ok) {
  console.error(result.error ?? `HTTP ${response.status}`);
  process.exit(1);
}
console.log(JSON.stringify(result, null, 2));

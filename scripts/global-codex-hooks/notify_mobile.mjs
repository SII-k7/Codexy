import { createHash, randomUUID } from 'node:crypto';

import {
  configured,
  firstString,
  nested,
  postJson,
  projectAlias,
  rawSessionId,
  readHookInput,
  relayToken,
  runNonBlocking,
  sessionReference,
  validatedEndpoint,
} from './hook_common.mjs';

const EVENT_STATE_MAP = new Map([
  ['agentturncomplete', 'turn_finished'],
  ['permissionrequest', 'needs_you'],
  ['stop', 'turn_finished'],
  ['sessionend', 'session_ended'],
  ['stopfailure', 'failed'],
]);
const DEFAULT_SUMMARIES = {
  needs_you: 'Codex needs your confirmation to continue',
  turn_finished: 'Codex finished this response',
  failed: 'Codex stopped because of an error',
  interrupted: 'Codex was interrupted',
  session_ended: 'Codex session ended',
};

function eventName(hook) {
  const value =
    firstString(
      hook?.hook_event_name,
      hook?.event_name,
      hook?.type,
      hook?.method,
    ) ?? 'Manual';
  return [...value].filter((character) => /[\p{L}\p{N}]/u.test(character)).join(
    '',
  ) || 'Manual';
}

function eventState(name, hook) {
  const normalized = name.toLowerCase();
  if (normalized === 'turncompleted') {
    const status = nested(hook, 'params', 'turn', 'status');
    return (
      {
        failed: 'failed',
        interrupted: 'interrupted',
        completed: 'turn_finished',
      }[status] ?? 'turn_finished'
    );
  }
  const state = EVENT_STATE_MAP.get(normalized);
  if (!state) {
    throw new Error(`unsupported Codex lifecycle event: ${name}`);
  }
  return state;
}

await runNonBlocking('notify', async () => {
  const token = relayToken();
  if (!token) {
    throw new Error('expected one active paired Codexy device');
  }
  const hook = readHookInput(process.argv[2]);
  const name = eventName(hook);
  const state = eventState(name, hook);
  const sessionId = rawSessionId(hook);
  const turnId = firstString(
    hook?.turn_id,
    hook?.['turn-id'],
    hook?.turnId,
    nested(hook, 'params', 'turnId'),
    nested(hook, 'params', 'turn', 'id'),
  );
  const eventId = randomUUID();
  const dedupeKey =
    sessionId || turnId
      ? `sha256:${createHash('sha256')
          .update(
            [sessionId ?? '', turnId ?? '', state, name].join('\x1f'),
            'utf8',
          )
          .digest('hex')
          .slice(0, 24)}`
      : `event:${eventId}`;
  await postJson(
    validatedEndpoint(
      configured('CODEXY_RELAY_URL', 'ATTENTION_RELAY_URL'),
      'http://127.0.0.1:8797/v1/events',
    ),
    token,
    {
      schema_version: '1.0',
      event_id: eventId,
      dedupe_key: dedupeKey,
      occurred_at: new Date().toISOString(),
      source: 'codex',
      state,
      event: name,
      project_alias: projectAlias(hook),
      summary: DEFAULT_SUMMARIES[state] ?? 'Codex status changed',
      ...(sessionId
        ? { session_ref: sessionReference(sessionId) }
        : {}),
    },
    'codexy-notify/2.0',
  );
});

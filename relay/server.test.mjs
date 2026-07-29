import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import webpush from 'web-push';

import { createRelayServer } from './server.mjs';
import { webPushPayloadForEvent } from './web-push.mjs';
import {
  loadRelayStore,
  persistRelayStore,
} from './store.mjs';
import { shouldNotifyForLevel } from './notifications.mjs';

let server;
let baseUrl;
let tempDirectories;

async function json(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function registerAndPair() {
  const registration = await json('/v1/devices/register', {
    method: 'POST',
    body: JSON.stringify({
      device_id: 'device-test-123',
      platform: 'test',
      expo_push_token: null,
    }),
  });
  assert.equal(registration.status, 200);

  const pairing = await json('/v1/pairings/claim', {
    method: 'POST',
    body: JSON.stringify({
      pairing_code: registration.body.pairing_code,
    }),
  });
  assert.equal(pairing.status, 200);

  return {
    deviceSecret: registration.body.device_secret,
    hookToken: pairing.body.relay_token,
  };
}

beforeEach(async () => {
  tempDirectories = [];
  const created = createRelayServer({
    pushSender: async () => ({ status: 'test_skipped' }),
  });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  for (const directory of tempDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('reports the isolated Codexy Relay identity', async () => {
  const health = await json('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.service, 'codexy-relay');
});

test('returns and updates authenticated device notification preferences', async () => {
  const { deviceSecret } = await registerAndPair();
  const authorization = { Authorization: `Bearer ${deviceSecret}` };

  const initial = await json('/v1/devices/device-test-123/status', {
    headers: authorization,
  });
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.preferences, {
    notification_tone: 'calm',
    notification_level: 'important',
  });

  const unauthorized = await json(
    '/v1/devices/device-test-123/preferences',
    {
      method: 'PATCH',
      body: JSON.stringify({ notification_tone: 'playful' }),
    },
  );
  assert.equal(unauthorized.status, 401);

  const updated = await json('/v1/devices/device-test-123/preferences', {
    method: 'PATCH',
    headers: authorization,
    body: JSON.stringify({
      notification_tone: 'playful',
      notification_level: 'decisions',
    }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.preferences, {
    notification_tone: 'playful',
    notification_level: 'decisions',
  });

  const partial = await json('/v1/devices/device-test-123/preferences', {
    method: 'PATCH',
    headers: authorization,
    body: JSON.stringify({ notification_tone: 'direct' }),
  });
  assert.deepEqual(partial.body.preferences, {
    notification_tone: 'direct',
    notification_level: 'decisions',
  });

  const invalid = await json('/v1/devices/device-test-123/preferences', {
    method: 'PATCH',
    headers: authorization,
    body: JSON.stringify({ notification_level: 'everything' }),
  });
  assert.equal(invalid.status, 400);
});

test('filters lifecycle pushes by level and passes one tone to both channels', async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const expoDeliveries = [];
  const webDeliveries = [];
  const created = createRelayServer({
    pushSender: async (_token, event, preferences) => {
      expoDeliveries.push({ event, preferences });
      return { status: 'sent' };
    },
    webPushSender: async (_subscriptions, event, preferences) => {
      webDeliveries.push({ event, preferences });
      return { status: 'sent', sent: 1, expiredEndpoints: [] };
    },
  });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const { deviceSecret, hookToken } = await registerAndPair();
  const postEvent = (eventId, state) =>
    json('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${hookToken}` },
      body: JSON.stringify({
        event_id: eventId,
        dedupe_key: eventId,
        occurred_at: new Date().toISOString(),
        source: 'codex',
        state,
        event: 'Lifecycle',
        project_alias: 'Filter project',
        summary: `${state} update`,
        session_ref: 'sha256:111122223333444455556666',
      }),
    });

  const working = await postEvent('filtered-working', 'working');
  assert.equal(working.status, 202);
  assert.deepEqual(working.body.push_channels, {
    expo: 'filtered',
    web: 'filtered',
  });
  assert.equal(expoDeliveries.length, 0);
  assert.equal(webDeliveries.length, 0);

  await postEvent('important-needs-you', 'needs_you');
  assert.equal(expoDeliveries.length, 1);
  assert.equal(webDeliveries.length, 1);
  assert.deepEqual(expoDeliveries[0].preferences, {
    notification_tone: 'calm',
    notification_level: 'important',
  });
  assert.deepEqual(
    webDeliveries[0].preferences,
    expoDeliveries[0].preferences,
  );

  const changed = await json('/v1/devices/device-test-123/preferences', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${deviceSecret}` },
    body: JSON.stringify({
      notification_tone: 'playful',
      notification_level: 'all',
    }),
  });
  assert.equal(changed.status, 200);
  await postEvent('playful-working', 'working');
  assert.equal(expoDeliveries.length, 2);
  assert.equal(webDeliveries.length, 2);
  assert.equal(expoDeliveries[1].preferences.notification_tone, 'playful');
  assert.equal(webDeliveries[1].preferences.notification_level, 'all');
});

test('builds truthful tone variants and session-isolated replacement tags', () => {
  const base = {
    state: 'needs_you',
    event_id: 'event-tone-1',
    project_alias: 'Project A',
    summary: 'Choose whether to apply the migration',
    session_ref: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const followUp = webPushPayloadForEvent(
    { ...base, event_id: 'event-tone-2', state: 'turn_finished' },
    { notification_tone: 'playful', notification_level: 'all' },
  );
  const first = webPushPayloadForEvent(base, {
    notification_tone: 'playful',
  });
  const otherSession = webPushPayloadForEvent({
    ...base,
    event_id: 'event-tone-3',
    session_ref: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbb',
  });

  assert.equal(first.title, '轮到你接棒了');
  assert.match(first.body, /等你的决定/);
  assert.doesNotMatch(first.body, /已完成/);
  assert.equal(first.tag, followUp.tag);
  assert.notEqual(first.tag, otherSession.tag);
  assert.equal(first.data.session_ref, base.session_ref);
  assert.equal(first.data.sessionRef, base.session_ref);
  assert.match(first.data.deepLink, /^codexy:\/\/session\//);
  assert.equal(
    first.data.url,
    '/?session_ref=sha256%3Aaaaaaaaaaaaaaaaaaaaaaaaa',
  );
});

test('uses the exact decisions, important, and all notification matrices', () => {
  const states = [
    'working',
    'needs_you',
    'turn_finished',
    'subtask_completed',
    'completed',
    'failed',
    'interrupted',
    'background_ended',
    'session_ended',
  ];
  assert.deepEqual(
    states.filter((state) => shouldNotifyForLevel(state, 'decisions')),
    ['needs_you', 'failed'],
  );
  assert.deepEqual(
    states.filter((state) => shouldNotifyForLevel(state, 'important')),
    [
      'needs_you',
      'turn_finished',
      'completed',
      'failed',
      'session_ended',
    ],
  );
  assert.deepEqual(
    states.filter((state) => shouldNotifyForLevel(state, 'all')),
    states,
  );
});

test('loads old device state with safe default notification preferences', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codexy-old-device-test-'));
  tempDirectories.push(directory);
  const stateFile = join(directory, 'state.json');
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      devices: [
        {
          deviceId: 'legacy-device-123',
          deviceSecret: 'legacy-device-secret',
          hookToken: 'legacy-hook-token',
          events: [],
        },
      ],
    }),
    'utf8',
  );
  const store = loadRelayStore(stateFile);
  assert.deepEqual(store.devices.get('legacy-device-123').preferences, {
    notification_tone: 'calm',
    notification_level: 'important',
  });
  persistRelayStore(stateFile, store);
  const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.deepEqual(persisted.devices[0].preferences, {
    notification_tone: 'calm',
    notification_level: 'important',
  });
});

test('registers, pairs, receives, acknowledges, and polls an event', async () => {
  const { deviceSecret, hookToken } = await registerAndPair();
  const event = {
    schema_version: '1.0',
    event_id: 'event-1',
    dedupe_key: 'dedupe-1',
    occurred_at: '2026-07-28T09:30:00Z',
    source: 'codex',
    state: 'needs_you',
    event: 'PermissionRequest',
    project_alias: 'Project A',
    summary: 'Agent needs confirmation',
  };

  const accepted = await json('/v1/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify(event),
  });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.cursor, 1);

  const polled = await json('/v1/devices/device-test-123/events?after=0', {
    headers: { Authorization: `Bearer ${deviceSecret}` },
  });
  assert.equal(polled.status, 200);
  assert.equal(polled.body.events.length, 1);
  assert.equal(polled.body.events[0].state, 'needs_you');

  const acknowledged = await json(
    '/v1/devices/device-test-123/events/event-1/ack',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceSecret}` },
      body: JSON.stringify({}),
    },
  );
  assert.equal(acknowledged.status, 200);

  const afterAck = await json('/v1/devices/device-test-123/events?after=0', {
    headers: { Authorization: `Bearer ${deviceSecret}` },
  });
  assert.ok(afterAck.body.events[0].acknowledged_at);
});

test('deduplicates repeated lifecycle deliveries', async () => {
  const { hookToken } = await registerAndPair();
  const event = {
    schema_version: '1.0',
    event_id: 'event-2',
    dedupe_key: 'same-delivery',
    occurred_at: new Date().toISOString(),
    source: 'codex',
    state: 'turn_finished',
    event: 'Stop',
    project_alias: 'Project B',
    summary: 'Turn finished',
  };

  const first = await json('/v1/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify(event),
  });
  const second = await json('/v1/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify({ ...event, event_id: 'event-3' }),
  });

  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.equal(second.body.deduplicated, true);
});

test('rejects non-Codex lifecycle and Prompt sources', async () => {
  const { hookToken } = await registerAndPair();
  const lifecycle = await json('/v1/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify({
      event_id: 'unsupported-source-event',
      dedupe_key: 'unsupported-source-event',
      occurred_at: new Date().toISOString(),
      source: 'claude-code',
      state: 'turn_finished',
      event: 'Stop',
      project_alias: 'Unsupported project',
      summary: 'Unsupported source',
    }),
  });
  assert.equal(lifecycle.status, 400);

  const prompt = await json('/v1/prompts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify({
      session_ref: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaa',
      source: 'claude-code',
      project_alias: 'Unsupported project',
      prompt_id: 'unsupported-source-prompt',
      captured_at: new Date().toISOString(),
      text: 'This source must be rejected.',
    }),
  });
  assert.equal(prompt.status, 400);
});

test('tracks parallel sessions with ten privacy-filtered prompts each', async () => {
  const { deviceSecret, hookToken } = await registerAndPair();
  const firstSession = 'sha256:111111111111111111111111';
  const secondSession = 'sha256:222222222222222222222222';

  for (let index = 0; index < 12; index += 1) {
    const captured = await json('/v1/prompts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${hookToken}` },
      body: JSON.stringify({
        session_ref: firstSession,
        source: 'codex',
        project_alias: 'Project A',
        prompt_id: `prompt-a-${index}`,
        captured_at: new Date(Date.now() + index).toISOString(),
        text:
          index === 11
            ? '请检查 C:\\private\\plan.md，token=super-secret-value，并参考 https://example.com'
            : `推进第 ${index + 1} 个界面要求`,
      }),
    });
    assert.equal(captured.status, 202);
  }

  const secondCaptured = await json('/v1/prompts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify({
      session_ref: secondSession,
      source: 'codex',
      project_alias: 'Project B',
      prompt_id: 'prompt-b-1',
      captured_at: new Date(Date.now() + 20).toISOString(),
      text: '保持第二个 CLI 的工作流独立。',
    }),
  });
  assert.equal(secondCaptured.status, 202);

  const statusEvent = await json('/v1/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify({
      event_id: 'parallel-needs-you',
      dedupe_key: 'parallel-needs-you',
      occurred_at: new Date(Date.now() + 30).toISOString(),
      source: 'codex',
      state: 'needs_you',
      event: 'PermissionRequest',
      project_alias: 'Project A',
      summary: 'Agent needs confirmation',
      session_ref: firstSession,
    }),
  });
  assert.equal(statusEvent.status, 202);

  const response = await json('/v1/devices/device-test-123/sessions', {
    headers: { Authorization: `Bearer ${deviceSecret}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.sessions.length, 2);

  const projectA = response.body.sessions.find(
    (session) => session.session_ref === firstSession,
  );
  const projectB = response.body.sessions.find(
    (session) => session.session_ref === secondSession,
  );
  assert.equal(projectA.prompt_count, 10);
  assert.equal(projectA.prompts[0].prompt_id, 'prompt-a-2');
  assert.equal(projectA.state, 'needs_you');
  assert.equal(projectB.prompt_count, 1);
  assert.equal(projectB.state, 'working');

  const latestText = projectA.prompts.at(-1).text;
  assert.doesNotMatch(latestText, /private\\plan/);
  assert.doesNotMatch(latestText, /super-secret-value/);
  assert.doesNotMatch(latestText, /example\.com/);
  assert.match(latestText, /\[path\]/);
  assert.match(latestText, /\[redacted\]/);
  assert.match(latestText, /\[link\]/);
});

test('queues an exact reviewed Prompt for one controllable Codex session', async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const dispatched = [];
  const fakeControl = {
    async start() {},
    stop() {},
    getStatus() {
      return {
        state: 'ready',
        detail: 'test control is ready',
        endpoint: 'localhost-only',
      };
    },
    statusForSession() {
      return 'ready';
    },
    async dispatch(command, setStatus) {
      dispatched.push({
        commandId: command.commandId,
        prompt: command.prompt,
        mode: command.mode,
        sessionRef: command.sessionRef,
      });
      setStatus('dispatching', 'test dispatch');
      return { turnId: 'turn-test-1' };
    },
  };
  const created = createRelayServer({
    codexControl: fakeControl,
    pushSender: async () => ({ status: 'test_skipped' }),
  });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const { deviceSecret, hookToken } = await registerAndPair();
  const sessionRef = 'sha256:abcdefabcdefabcdefabcdef';
  const captured = await json('/v1/prompts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify({
      session_ref: sessionRef,
      source: 'codex',
      project_alias: 'Remote project',
      prompt_id: 'remote-source-prompt',
      captured_at: new Date().toISOString(),
      text: '先建立一个可控轨道。',
    }),
  });
  assert.equal(captured.status, 202);

  const exactPrompt =
    '保留现有实现。\n\n只补充一组 iPhone 交互测试，不要发布。';
  const first = await json('/v1/devices/device-test-123/remote-prompts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceSecret}` },
    body: JSON.stringify({
      session_ref: sessionRef,
      prompt: exactPrompt,
      mode: 'queue',
      idempotency_key: 'mobile-idempotency-1',
    }),
  });
  assert.equal(first.status, 202);
  assert.equal(first.body.command.mode, 'queue');
  assert.equal(first.body.command.prompt_length, exactPrompt.length);
  assert.equal(first.body.command.prompt, undefined);
  assert.equal(first.body.exact_prompt_persisted, false);

  const repeated = await json(
    '/v1/devices/device-test-123/remote-prompts',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceSecret}` },
      body: JSON.stringify({
        session_ref: sessionRef,
        prompt: exactPrompt,
        mode: 'queue',
        idempotency_key: 'mobile-idempotency-1',
      }),
    },
  );
  assert.equal(repeated.status, 202);
  assert.equal(
    repeated.body.command.command_id,
    first.body.command.command_id,
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].prompt, exactPrompt);
  assert.equal(dispatched[0].sessionRef, sessionRef);

  const listed = await json(
    '/v1/devices/device-test-123/remote-prompts',
    {
      headers: { Authorization: `Bearer ${deviceSecret}` },
    },
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.body.commands.length, 1);
  assert.equal(listed.body.commands[0].status, 'sent');
  assert.equal(listed.body.commands[0].turn_id, 'turn-test-1');
  assert.equal(listed.body.commands[0].prompt, undefined);
});

test('keeps exact remote Prompt text out of durable Relay state', async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const directory = mkdtempSync(join(tmpdir(), 'codexy-command-test-'));
  tempDirectories.push(directory);
  const stateFile = join(directory, 'state.json');
  const fakeControl = {
    async start() {},
    stop() {},
    getStatus: () => ({
      state: 'ready',
      detail: 'test control is ready',
      endpoint: 'localhost-only',
    }),
    statusForSession: () => 'ready',
    dispatch: async () => ({ turnId: 'turn-private-1' }),
  };
  const created = createRelayServer({
    codexControl: fakeControl,
    pushSender: async () => ({ status: 'test_skipped' }),
    stateFile,
  });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const { deviceSecret, hookToken } = await registerAndPair();
  const sessionRef = 'sha256:999999999999999999999999';
  await json('/v1/prompts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify({
      session_ref: sessionRef,
      source: 'codex',
      project_alias: 'Private command project',
      prompt_id: 'private-command-source',
      captured_at: new Date().toISOString(),
      text: '建立远程控制测试轨道。',
    }),
  });
  const secretCommand = 'REMOTE-ONLY-DO-NOT-PERSIST-84729';
  const sent = await json('/v1/devices/device-test-123/remote-prompts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceSecret}` },
    body: JSON.stringify({
      session_ref: sessionRef,
      prompt: secretCommand,
      mode: 'queue',
      idempotency_key: 'private-state-test-1',
    }),
  });
  assert.equal(sent.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const durableState = readFileSync(stateFile, 'utf8');
  assert.doesNotMatch(durableState, new RegExp(secretCommand));
});

test('does not expose the removed global intent-summary API', async () => {
  const { deviceSecret, hookToken } = await registerAndPair();
  const published = await json('/v1/intent-summaries', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify({
      current_goal: 'Build the notification proof of concept.',
      constraints: ['Keep transcript data local.'],
      unresolved: ['Choose the production relay host.'],
      suggested_prompt: 'Implement the relay and verify one real device.',
      source_prompt_count: 6,
    }),
  });
  assert.equal(published.status, 404);

  const read = await json(
    '/v1/devices/device-test-123/intent-summary',
    {
      headers: { Authorization: `Bearer ${deviceSecret}` },
    },
  );
  assert.equal(read.status, 404);
});

test('rejects unauthenticated event delivery', async () => {
  await registerAndPair();
  const response = await json('/v1/events', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 401);
});

test('registers an authenticated Web Push subscription and uses it', async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const vapid = webpush.generateVAPIDKeys();
  let deliveredSubscriptionCount = 0;
  let deliveredEvent = null;
  const created = createRelayServer({
    pushSender: async () => ({ status: 'not_configured' }),
    webPushSender: async (subscriptions, event) => {
      deliveredSubscriptionCount = subscriptions.length;
      deliveredEvent = event;
      return { status: 'sent', sent: subscriptions.length, expiredEndpoints: [] };
    },
    vapid: {
      subject: 'mailto:self@example.test',
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
  });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const { deviceSecret, hookToken } = await registerAndPair();
  const subscribed = await json(
    '/v1/devices/device-test-123/web-push-subscriptions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceSecret}` },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.test/subscription-1',
          expirationTime: null,
          keys: {
            p256dh: 'test-p256dh',
            auth: 'test-auth',
          },
        },
      }),
    },
  );
  assert.equal(subscribed.status, 200);

  const status = await json('/v1/devices/device-test-123/status', {
    headers: { Authorization: `Bearer ${deviceSecret}` },
  });
  assert.equal(status.body.web_push_configured, true);

  const accepted = await json('/v1/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify({
      event_id: 'web-push-event',
      dedupe_key: 'web-push-delivery',
      occurred_at: new Date().toISOString(),
      source: 'codex',
      state: 'needs_you',
      event: 'PermissionRequest',
      project_alias: 'Private project',
      summary: 'Agent needs a decision',
      session_ref: 'sha256:1234567890abcdef12345678',
      raw_prompt: 'never deliver this prompt',
      code: 'never deliver this code',
      path: 'C:\\private\\project',
    }),
  });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.push_channels.web, 'sent');
  assert.equal(deliveredSubscriptionCount, 1);
  assert.equal(deliveredEvent.raw_prompt, undefined);
  assert.equal(deliveredEvent.code, undefined);
  assert.equal(deliveredEvent.path, undefined);
  const pushPayload = webPushPayloadForEvent(deliveredEvent);
  assert.equal(
    pushPayload.data.sessionRef,
    'sha256:1234567890abcdef12345678',
  );
  assert.match(pushPayload.data.deepLink, /^codexy:\/\/session\//);
  assert.equal(
    pushPayload.data.url,
    '/?session_ref=sha256%3A1234567890abcdef12345678',
  );
});

test('restores paired devices and Web Push subscriptions from local state', async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const directory = mkdtempSync(join(tmpdir(), 'codexy-relay-test-'));
  tempDirectories.push(directory);
  const stateFile = join(directory, 'state.json');
  const vapid = webpush.generateVAPIDKeys();
  const options = {
    stateFile,
    webPushSender: async () => ({
      status: 'test_skipped',
      sent: 0,
      expiredEndpoints: [],
    }),
    vapid: {
      subject: 'mailto:self@example.test',
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
  };

  let created = createRelayServer(options);
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { deviceSecret } = await registerAndPair();
  const subscribed = await json(
    '/v1/devices/device-test-123/web-push-subscriptions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceSecret}` },
      body: JSON.stringify({
        endpoint: 'https://push.example.test/persisted',
        keys: { p256dh: 'persisted-p256dh', auth: 'persisted-auth' },
      }),
    },
  );
  assert.equal(subscribed.status, 200);
  const stateFileContents = JSON.parse(readFileSync(stateFile, 'utf8'));
  const persistedHookToken = stateFileContents.devices[0].hookToken;
  const captured = await json('/v1/prompts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${persistedHookToken}` },
    body: JSON.stringify({
      session_ref: 'sha256:abcdefabcdefabcdefabcdef',
      source: 'codex',
      project_alias: 'Persisted project',
      prompt_id: 'persisted-prompt',
      captured_at: new Date().toISOString(),
      text: 'Keep this sanitized prompt across a Relay restart.',
    }),
  });
  assert.equal(captured.status, 202);
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  created = createRelayServer(options);
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const restored = await json('/v1/devices/device-test-123/status', {
    headers: { Authorization: `Bearer ${deviceSecret}` },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.paired, true);
  assert.equal(restored.body.web_push_configured, true);
  const sessions = await json('/v1/devices/device-test-123/sessions', {
    headers: { Authorization: `Bearer ${deviceSecret}` },
  });
  assert.equal(sessions.status, 200);
  assert.equal(sessions.body.sessions.length, 1);
  assert.equal(sessions.body.sessions[0].prompt_count, 1);
});

test('serves the private PWA with conservative security and cache headers', async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const directory = mkdtempSync(join(tmpdir(), 'codexy-web-test-'));
  tempDirectories.push(directory);
  writeFileSync(
    join(directory, 'index.html'),
    '<!doctype html><title>Private Codexy</title>',
    'utf8',
  );
  writeFileSync(join(directory, 'sw.js'), 'self.addEventListener("fetch",()=>{})', 'utf8');

  const created = createRelayServer({ webRoot: directory });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/some/app/route`, {
    headers: { Accept: 'text/html' },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Private Codexy/);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');

  const worker = await fetch(`${baseUrl}/sw.js`);
  assert.equal(worker.headers.get('cache-control'), 'no-cache');
  assert.equal(worker.headers.get('service-worker-allowed'), '/');
});

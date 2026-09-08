import assert from 'node:assert/strict';
import test from 'node:test';

import webpush from 'web-push';

import { createWebPushSender } from './web-push.mjs';

const EVENT = Object.freeze({
  event_id: 'web-push-expiry-test',
  state: 'needs_you',
  project_alias: 'Codexy',
  summary: 'A fixed test event.',
});

function subscription(endpoint) {
  return {
    endpoint,
    keys: { auth: 'test-auth', p256dh: 'test-p256dh' },
  };
}

function pushError(statusCode) {
  return Object.assign(new Error(`Push service returned ${statusCode}`), {
    statusCode,
  });
}

test('reports expired when every Web Push endpoint returns 404 or 410', async (t) => {
  const originalSendNotification = webpush.sendNotification;
  t.after(() => {
    webpush.sendNotification = originalSendNotification;
  });
  webpush.sendNotification = async (target) => {
    throw pushError(target.endpoint.endsWith('/404') ? 404 : 410);
  };

  const send = createWebPushSender({ configured: true });
  const endpoints = [
    'https://push.example.test/404',
    'https://push.example.test/410',
  ];
  const result = await send(endpoints.map(subscription), EVENT);

  assert.equal(result.status, 'expired');
  assert.equal(result.sent, 0);
  assert.deepEqual(result.expiredEndpoints, endpoints);
});

test('reports expired when no push is sent and expiry is mixed with another failure', async (t) => {
  const originalSendNotification = webpush.sendNotification;
  t.after(() => {
    webpush.sendNotification = originalSendNotification;
  });
  webpush.sendNotification = async (target) => {
    throw pushError(target.endpoint.endsWith('/gone') ? 410 : 503);
  };

  const send = createWebPushSender({ configured: true });
  const result = await send(
    [
      subscription('https://push.example.test/gone'),
      subscription('https://push.example.test/unavailable'),
    ],
    EVENT,
  );

  assert.equal(result.status, 'expired');
  assert.equal(result.sent, 0);
  assert.deepEqual(result.expiredEndpoints, [
    'https://push.example.test/gone',
  ]);
});

test('keeps sent status when at least one endpoint succeeds', async (t) => {
  const originalSendNotification = webpush.sendNotification;
  t.after(() => {
    webpush.sendNotification = originalSendNotification;
  });
  webpush.sendNotification = async (target) => {
    if (target.endpoint.endsWith('/gone')) throw pushError(404);
  };

  const send = createWebPushSender({ configured: true });
  const result = await send(
    [
      subscription('https://push.example.test/ok'),
      subscription('https://push.example.test/gone'),
    ],
    EVENT,
  );

  assert.equal(result.status, 'sent');
  assert.equal(result.sent, 1);
  assert.deepEqual(result.expiredEndpoints, [
    'https://push.example.test/gone',
  ]);
});

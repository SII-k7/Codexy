import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './relay') {
      return {
        shortCircuit: true,
        url:
          'data:text/javascript,export%20function%20normalizeRelayUrl(value)%7Breturn%20value.trim().replace(%2F%5C%2F%2B%24%2F%2C%22%22)%7D',
      };
    }
    if (specifier === './webPushTypes') {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { enableWebPush, resetExpiredWebPush, disableWebPush, pushScope } = await import(
  './webPush.web.ts'
);

test('computers with different VAPID keys keep independent subscriptions', async () => {
  const registrations = new Map(); const removed = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    standalone: true, userAgent: 'iPhone', serviceWorker: {
      async getRegistration(scope) { return registrations.get(scope); },
      async register(_script, { scope }) {
        if (!registrations.has(scope)) {
          let subscription = null;
          registrations.set(scope, { scope: `https://mobile.example${scope}`, active: {}, pushManager: {
            async getSubscription() { return subscription; },
            async subscribe(options) { subscription = { options,
              async unsubscribe() { removed.push(scope); subscription = null; return true; },
              toJSON() { return { endpoint: 'https://push.example/test', keys: { auth: 'test', p256dh: 'test' } }; },
            }; return subscription; },
          } });
        }
        return registrations.get(scope);
      },
    },
  } });
  globalThis.Notification = { permission: 'granted', requestPermission: async () => 'granted' };
  globalThis.window = { Notification, PushManager: class {}, isSecureContext: true, atob: (value) => Buffer.from(value, 'base64').toString('binary'), matchMedia: () => ({ matches: true }) };
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith('vapid-public-key') ? { public_key: String(url).includes('one.example') ? 'AQID' : 'BAUG' } : {}));
  const one = { relayUrl: 'https://one.example', deviceId: 'phone', deviceSecret: 'one' };
  const two = { relayUrl: 'https://two.example', deviceId: 'phone', deviceSecret: 'two' };
  assert.equal((await enableWebPush(one)).phase, 'subscribed');
  assert.equal((await enableWebPush(two)).phase, 'subscribed');
  assert.notEqual(pushScope(one), pushScope(two)); assert.deepEqual(removed, []);
  await disableWebPush(two);
  assert.ok(await registrations.get(pushScope(one)).pushManager.getSubscription());
  assert.deepEqual(removed, [pushScope(two)]);
});

test('expired Web Push can be cleared and explicitly re-enabled', async () => {
  let currentSubscription;
  let unsubscribeCount = 0;
  let subscribeCount = 0;
  let savedSubscriptionCount = 0;

  const makeSubscription = () => ({
    endpoint: `https://push.example.test/${subscribeCount}`,
    options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
    async unsubscribe() {
      unsubscribeCount += 1;
      currentSubscription = null;
      return true;
    },
    toJSON() {
      return { endpoint: this.endpoint, keys: { auth: 'a', p256dh: 'b' } };
    },
  });
  currentSubscription = makeSubscription();

  const registration = {
    pushManager: {
      async getSubscription() {
        return currentSubscription;
      },
      async subscribe() {
        subscribeCount += 1;
        currentSubscription = makeSubscription();
        return currentSubscription;
      },
    },
  };

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serviceWorker: {
        async getRegistration() {
          return registration;
        },
        async register() {
          return registration;
        },
        ready: Promise.resolve(registration),
      },
      standalone: true,
      userAgent: 'iPhone',
    },
  });
  globalThis.Notification = {
    permission: 'granted',
    async requestPermission() {
      return 'granted';
    },
  };
  globalThis.window = {
    Notification: globalThis.Notification,
    PushManager: class {},
    atob(value) {
      return Buffer.from(value, 'base64').toString('binary');
    },
    isSecureContext: true,
    matchMedia() {
      return { matches: true };
    },
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/web-push/vapid-public-key')) {
      return new Response(JSON.stringify({ public_key: 'AQID' }), {
        status: 200,
      });
    }
    assert.equal(init?.method, 'POST');
    savedSubscriptionCount += 1;
    return new Response('{}', { status: 200 });
  };

  const expired = await resetExpiredWebPush();
  assert.equal(expired.phase, 'expired');
  assert.equal(expired.canEnable, true);
  assert.equal(unsubscribeCount, 1);

  // Even if a stale local subscription reappears, an explicit user action
  // rotates it before saving the replacement to the Relay.
  currentSubscription = makeSubscription();
  const enabled = await enableWebPush({
    relayUrl: 'https://codexy.example.test',
    deviceId: 'device-1',
    deviceSecret: 'secret-1',
  });
  assert.equal(enabled.phase, 'subscribed');
  assert.equal(unsubscribeCount, 2);
  assert.equal(subscribeCount, 1);
  assert.equal(savedSubscriptionCount, 1);
});

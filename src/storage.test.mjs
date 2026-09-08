import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';

import ts from 'typescript';

const HIDDEN_SESSIONS_KEY = 'codexy.hidden-sessions.v1';
const NOTIFICATION_TEST_CONFIRMED_KEY =
  'codexy.notification-test-confirmed.v1';

class MemoryStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
  }

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  setItem(key, value) {
    this.#values.set(key, value);
  }
}

const localStorage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: localStorage,
});

const source = readFileSync(new URL('./storage.ts', import.meta.url), 'utf8')
  .replace(
    /^import \{ Platform \} from 'react-native';$/m,
    "const Platform = { OS: 'web' };",
  )
  .replace(
    /^import \* as SecureStore from 'expo-secure-store';$/m,
    `const SecureStore = {
      getItemAsync: async () => null,
      setItemAsync: async () => undefined,
      deleteItemAsync: async () => undefined,
    };`,
  );
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: 'storage.ts',
});
const storage = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

const device = {
  relayUrl: 'https://desktop.example.ts.net:8443',
  deviceId: 'device-a',
  deviceSecret: 'secret-a',
};

beforeEach(() => {
  localStorage.clear();
});

test('binds notification-test confirmation to relay URL and device ID', async () => {
  await storage.saveNotificationTestConfirmed(device, true);

  assert.deepEqual(
    JSON.parse(localStorage.getItem(NOTIFICATION_TEST_CONFIRMED_KEY)),
    {
      version: 1,
      relayUrl: device.relayUrl,
      deviceId: device.deviceId,
    },
  );
  assert.equal(await storage.loadNotificationTestConfirmed(device), true);
  assert.equal(
    await storage.loadNotificationTestConfirmed({
      ...device,
      relayUrl: 'https://another.example.ts.net:8443',
    }),
    false,
  );
  assert.equal(
    await storage.loadNotificationTestConfirmed({
      ...device,
      deviceId: 'device-b',
    }),
    false,
  );
});

test('legacy device migrates once and saving a fleet never overwrites another credential', async () => {
  const first = { relayUrl: 'https://first.example', deviceId: 'phone-a', deviceSecret: 'secret-a' };
  await storage.saveDevice(first);
  const migrated = await storage.loadHosts();
  assert.equal(migrated[0].deviceSecret, 'secret-a');
  const second = { relayUrl: 'https://second.example', deviceId: 'phone-b', deviceSecret: 'secret-b' };
  await storage.saveHosts([...migrated, second]);
  assert.equal((await storage.loadHosts()).length, 2);
  await storage.saveHosts([]);
  assert.deepEqual(await storage.loadHosts(), []);
});

test('identical session refs cannot share hidden state or drafts between computers', async () => {
  const ref = 'sha256:1111222233334444';
  await storage.saveHiddenSessionRefs([ref], 'host-one');
  assert.deepEqual(await storage.loadHiddenSessionRefs('host-two'), []);
  await storage.savePromptDraft(`host-one|${ref}`, 'private draft');
  assert.equal(await storage.loadPromptDraft(`host-two|${ref}`), '');
});

test('ignores the legacy unbound true value', async () => {
  localStorage.setItem(NOTIFICATION_TEST_CONFIRMED_KEY, 'true');
  assert.equal(await storage.loadNotificationTestConfirmed(device), false);
});

test('clears a device notification confirmation when it is revoked', async () => {
  await storage.saveNotificationTestConfirmed(device, true);
  await storage.saveNotificationTestConfirmed(device, false);

  assert.equal(localStorage.getItem(NOTIFICATION_TEST_CONFIRMED_KEY), null);
  assert.equal(await storage.loadNotificationTestConfirmed(device), false);
});

test('returns the sanitized hidden-session list that was persisted', async () => {
  const refs = Array.from(
    { length: 18 },
    (_, index) => `sha256:${(index + 1).toString(16).padStart(16, '0')}`,
  );
  const expected = refs.slice(-16);

  const persisted = await storage.saveHiddenSessionRefs([
    refs[0],
    'not-a-session-ref',
    ...refs,
    refs[2],
  ]);

  assert.deepEqual(persisted, expected);
  assert.deepEqual(
    JSON.parse(localStorage.getItem(HIDDEN_SESSIONS_KEY)),
    expected,
  );
  assert.deepEqual(await storage.loadHiddenSessionRefs(), expected);
});

test('returns an empty list when hidden-session persistence is removed', async () => {
  localStorage.setItem(
    HIDDEN_SESSIONS_KEY,
    JSON.stringify(['sha256:1111222233334444']),
  );

  assert.deepEqual(await storage.saveHiddenSessionRefs([]), []);
  assert.equal(localStorage.getItem(HIDDEN_SESSIONS_KEY), null);
});

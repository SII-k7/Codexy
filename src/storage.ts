import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import type { SavedDevice } from './types';

const DEVICE_KEY = 'codexy.saved-device.v1';
const HOSTS_KEY = 'codexy.hosts.v1';
const DRAFT_KEY_PREFIX = 'codexy.prompt-draft.v1.';
const DRAFT_INDEX_KEY = 'codexy.prompt-draft-index.v1';
const HIDDEN_SESSIONS_KEY = 'codexy.hidden-sessions.v1';
const NOTIFICATION_TEST_CONFIRMED_KEY =
  'codexy.notification-test-confirmed.v1';

interface NotificationTestConfirmation {
  version: 1;
  relayUrl: string;
  deviceId: string;
}

interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): BrowserStorage | null {
  const candidate = (globalThis as { localStorage?: BrowserStorage }).localStorage;
  return candidate ?? null;
}

function secureKey(key: string): string {
  // Expo SecureStore accepts only alphanumeric characters, dots, dashes and
  // underscores. URL/session-scoped keys contain colons and percent escapes.
  return /^[a-zA-Z0-9._-]+$/.test(key) ? key
    : `codexy.encoded.${Array.from(key, (character) => character.codePointAt(0)!.toString(16)).join('-')}`;
}

async function getValue(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return browserStorage()?.getItem(key) ?? null;
  }
  return SecureStore.getItemAsync(secureKey(key));
}

async function setValue(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    browserStorage()?.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(secureKey(key), value);
}

async function deleteValue(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    browserStorage()?.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(secureKey(key));
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function loadSavedDevice(): Promise<SavedDevice | null> {
  return parseJson<SavedDevice | null>(await getValue(DEVICE_KEY), null);
}

export async function saveDevice(device: SavedDevice): Promise<void> {
  await setValue(DEVICE_KEY, JSON.stringify(device));
}

export async function loadHosts(): Promise<SavedDevice[]> {
  const stored = parseJson<unknown>(await getValue(HOSTS_KEY), null);
  if (Array.isArray(stored)) return stored.filter((host): host is SavedDevice =>
    Boolean(host && typeof host.deviceId === 'string' &&
      typeof host.deviceSecret === 'string' && typeof host.relayUrl === 'string'));
  const legacy = await loadSavedDevice();
  const hosts = legacy ? [{ ...legacy, label: legacy.label || '我的电脑' }] : [];
  await saveHosts(hosts);
  return hosts;
}

export async function saveHosts(hosts: SavedDevice[]): Promise<void> {
  await setValue(HOSTS_KEY, JSON.stringify(hosts));
}

function hiddenKey(scope?: string): string {
  return scope ? `${HIDDEN_SESSIONS_KEY}.${encodeURIComponent(scope)}` : HIDDEN_SESSIONS_KEY;
}

export async function loadHiddenSessionRefs(scope?: string): Promise<string[]> {
  const value = parseJson<unknown>(await getValue(hiddenKey(scope)), []);
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is string =>
        typeof item === 'string' &&
        /^sha256:[a-f0-9]{16,64}$/iu.test(item),
    )
    .slice(-16);
}

export async function saveHiddenSessionRefs(
  sessionRefs: string[],
  scope?: string,
): Promise<string[]> {
  const sanitized = [...new Set(sessionRefs)]
    .filter((item) => /^sha256:[a-f0-9]{16,64}$/iu.test(item))
    .slice(-16);
  if (!sanitized.length) {
    await deleteValue(hiddenKey(scope));
    return [];
  }
  await setValue(hiddenKey(scope), JSON.stringify(sanitized));
  return sanitized;
}

function isNotificationTestConfirmation(
  value: unknown,
): value is NotificationTestConfirmation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<NotificationTestConfirmation>;
  return (
    candidate.version === 1 &&
    typeof candidate.relayUrl === 'string' &&
    typeof candidate.deviceId === 'string'
  );
}

export async function loadNotificationTestConfirmed(
  device: SavedDevice,
): Promise<boolean> {
  const value = parseJson<unknown>(
    await getValue(NOTIFICATION_TEST_CONFIRMED_KEY),
    null,
  );
  return (
    isNotificationTestConfirmation(value) &&
    value.relayUrl === device.relayUrl &&
    value.deviceId === device.deviceId
  );
}

export async function saveNotificationTestConfirmed(
  device: SavedDevice,
  confirmed: boolean,
): Promise<void> {
  if (!confirmed) {
    await deleteValue(NOTIFICATION_TEST_CONFIRMED_KEY);
    return;
  }
  const value: NotificationTestConfirmation = {
    version: 1,
    relayUrl: device.relayUrl,
    deviceId: device.deviceId,
  };
  await setValue(NOTIFICATION_TEST_CONFIRMED_KEY, JSON.stringify(value));
}

export async function clearSavedDevice(): Promise<void> {
  await deleteValue(DEVICE_KEY);
  await deleteValue(HOSTS_KEY);
}

function draftKey(sessionRef: string): string {
  return `${DRAFT_KEY_PREFIX}${encodeURIComponent(sessionRef)}`;
}

export async function loadPromptDraft(sessionRef: string): Promise<string> {
  return (await getValue(draftKey(sessionRef))) ?? '';
}

export async function savePromptDraft(
  sessionRef: string,
  draft: string,
): Promise<void> {
  const key = draftKey(sessionRef);
  const currentIndex = parseJson<string[]>(
    await getValue(DRAFT_INDEX_KEY),
    [],
  );
  if (!draft) {
    await deleteValue(key);
    await setValue(
      DRAFT_INDEX_KEY,
      JSON.stringify(currentIndex.filter((item) => item !== key)),
    );
    return;
  }
  await setValue(key, draft);
  if (!currentIndex.includes(key)) {
    await setValue(
      DRAFT_INDEX_KEY,
      JSON.stringify([...currentIndex, key].slice(-100)),
    );
  }
}

export async function clearAllCodexyStorage(): Promise<void> {
  const indexed = parseJson<string[]>(await getValue(DRAFT_INDEX_KEY), []);
  const browser = Platform.OS === 'web' ? browserStorage() : null;
  const discovered: string[] = [];
  if (browser && 'length' in browser && 'key' in browser) {
    const iterable = browser as BrowserStorage & {
      key(index: number): string | null;
      length: number;
    };
    for (let index = 0; index < iterable.length; index += 1) {
      const key = iterable.key(index);
      if (key?.startsWith(DRAFT_KEY_PREFIX)) discovered.push(key);
    }
  }
  for (const key of new Set([...indexed, ...discovered])) {
    await deleteValue(key);
  }
  await deleteValue(DRAFT_INDEX_KEY);
  await deleteValue(HIDDEN_SESSIONS_KEY);
  await deleteValue(NOTIFICATION_TEST_CONFIRMED_KEY);
  await deleteValue(DEVICE_KEY);
}

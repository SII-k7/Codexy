import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import type { SavedDevice } from './types';

const DEVICE_KEY = 'codexy.saved-device.v1';
const DRAFT_KEY_PREFIX = 'codexy.prompt-draft.v1.';
const DRAFT_INDEX_KEY = 'codexy.prompt-draft-index.v1';

interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): BrowserStorage | null {
  const candidate = (globalThis as { localStorage?: BrowserStorage }).localStorage;
  return candidate ?? null;
}

async function getValue(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return browserStorage()?.getItem(key) ?? null;
  }
  return SecureStore.getItemAsync(key);
}

async function setValue(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    browserStorage()?.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function deleteValue(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    browserStorage()?.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
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

export async function clearSavedDevice(): Promise<void> {
  await deleteValue(DEVICE_KEY);
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
  await deleteValue(DEVICE_KEY);
}

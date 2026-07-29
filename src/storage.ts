import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import type { SavedDevice } from './types';

const DEVICE_KEY = 'codexy.saved-device.v1';
const DRAFT_KEY_PREFIX = 'codexy.prompt-draft.v1.';

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
  if (!draft) {
    await deleteValue(draftKey(sessionRef));
    return;
  }
  await setValue(draftKey(sessionRef), draft);
}

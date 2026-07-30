import { normalizeRelayUrl } from './relay';
import type { WebPushStatus } from './webPushTypes';

export type { WebPushPhase, WebPushStatus } from './webPushTypes';

const UNSUPPORTED: WebPushStatus = {
  phase: 'unsupported',
  label: '此浏览器暂不支持',
  detail: '请使用较新的 Safari、Chrome 或 Edge。',
  canEnable: false,
};

function isInstalledWebApp(): boolean {
  const navigatorWithStandalone = navigator as Navigator & {
    standalone?: boolean;
  };
  return (
    navigatorWithStandalone.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function permissionStatus(): NotificationPermission {
  return Notification.permission;
}

function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function errorStatus(detail: string): WebPushStatus {
  return {
    phase: 'error',
    label: '启用未完成',
    detail,
    canEnable: true,
  };
}

async function existingSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration?.pushManager.getSubscription() ?? null;
}

function subscriptionUsesKey(
  subscription: PushSubscription,
  expected: Uint8Array<ArrayBuffer>,
): boolean {
  const configured = subscription.options.applicationServerKey;
  if (!configured) return false;
  const actual = new Uint8Array(configured);
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

async function publicKeyForRelay(relayUrl: string): Promise<string> {
  const response = await fetch(
    `${normalizeRelayUrl(relayUrl)}/v1/web-push/vapid-public-key`,
    { headers: { Accept: 'application/json' } },
  );
  const body = (await response.json().catch(() => ({}))) as {
    public_key?: string;
    error?: string;
  };
  if (!response.ok || !body.public_key) {
    throw new Error(
      body.error === 'web push is not configured'
        ? '这台电脑还没有完成私有推送配置。'
        : '无法从私有 Relay 取得推送公钥。',
    );
  }
  return body.public_key;
}

async function saveSubscription(
  input: {
    relayUrl: string;
    deviceId: string;
    deviceSecret: string;
  },
  subscription: PushSubscription,
): Promise<void> {
  const response = await fetch(
    `${normalizeRelayUrl(input.relayUrl)}/v1/devices/${encodeURIComponent(input.deviceId)}/web-push-subscriptions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.deviceSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    },
  );
  if (!response.ok) {
    throw new Error('浏览器已允许通知，但 Relay 尚未保存这台设备。');
  }
}

async function synchronizeSubscription(
  input: {
    relayUrl: string;
    deviceId: string;
    deviceSecret: string;
  },
  createIfMissing: boolean,
): Promise<WebPushStatus> {
  const publicKey = await publicKeyForRelay(input.relayUrl);
  const expectedKey = base64UrlToUint8Array(publicKey);
  const registration =
    (await navigator.serviceWorker.getRegistration()) ??
    (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !subscriptionUsesKey(subscription, expectedKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription && createIfMissing) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: expectedKey,
    });
  }
  if (!subscription) return DEFAULT_WEB_PUSH_STATUS;
  await saveSubscription(input, subscription);
  return {
    phase: 'subscribed',
    label: '后台通知已启用',
    detail: '浏览器订阅与电脑 Relay 已核对，可以接收后台提醒。',
    canEnable: false,
  };
}

export const DEFAULT_WEB_PUSH_STATUS: WebPushStatus = {
  phase: 'ready',
  label: '可启用',
  detail: '启用后，即使没有打开 Codexy，Codex 也能在需要你时提醒。',
  canEnable: true,
};

export async function getWebPushStatus(): Promise<WebPushStatus> {
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return UNSUPPORTED;
  }
  if (!window.isSecureContext) {
    return {
      phase: 'insecure',
      label: '需要私有 HTTPS',
      detail: '从 Tailscale 的 https:// 地址打开，才能启用后台通知。',
      canEnable: false,
    };
  }
  if (isIos() && !isInstalledWebApp()) {
    return {
      phase: 'install-required',
      label: '先添加到主屏幕',
      detail:
        '在 iPhone Safari 点“分享”→“添加到主屏幕”，从桌面打开后再启用。',
      canEnable: false,
    };
  }
  if (permissionStatus() === 'denied') {
    return {
      phase: 'denied',
      label: '通知已被关闭',
      detail: '请在系统设置中允许 Codexy 的通知，然后重新打开应用。',
      canEnable: false,
    };
  }
  try {
    if (await existingSubscription()) {
      return {
        phase: 'subscribed',
        label: '浏览器已允许通知',
        detail: '连接电脑后会自动核对 Relay 订阅与推送密钥。',
        canEnable: false,
      };
    }
  } catch {
    return errorStatus('暂时无法读取通知状态，可以稍后重试。');
  }
  return DEFAULT_WEB_PUSH_STATUS;
}

export async function syncWebPush(input: {
  relayUrl: string;
  deviceId: string;
  deviceSecret: string;
}): Promise<WebPushStatus> {
  const status = await getWebPushStatus();
  if (
    ['unsupported', 'insecure', 'install-required', 'denied'].includes(
      status.phase,
    )
  ) {
    return status;
  }
  if (permissionStatus() !== 'granted') return status;
  try {
    return await synchronizeSubscription(input, true);
  } catch (error) {
    return errorStatus(
      error instanceof Error
        ? error.message
        : '无法核对电脑端的后台通知订阅。',
    );
  }
}

export async function enableWebPush(input: {
  relayUrl: string;
  deviceId: string;
  deviceSecret: string;
}): Promise<WebPushStatus> {
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window) ||
    !window.isSecureContext ||
    (isIos() && !isInstalledWebApp()) ||
    permissionStatus() === 'denied'
  ) {
    return getWebPushStatus();
  }

  try {
    const permission =
      permissionStatus() === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
    if (permission !== 'granted') {
      return permission === 'denied'
        ? {
            phase: 'denied',
            label: '通知未获允许',
            detail: '没有你的明确允许，Codexy 不会发送后台通知。',
            canEnable: false,
          }
        : errorStatus('你暂时没有允许通知，可以需要时再开启。');
    }

    return await synchronizeSubscription(input, true);
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'NotAllowedError'
        ? '系统没有允许通知；你可以稍后从设置中重新开启。'
        : '启用后台通知时遇到问题，请确认私有 HTTPS 地址仍可访问。';
    return errorStatus(message);
  }
}

export async function disableWebPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const subscription = await existingSubscription();
    await subscription?.unsubscribe();
  } catch {
    // Device deletion on the Relay is authoritative; local cleanup is best effort.
  }
}

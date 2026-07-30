import type { WebPushStatus } from './webPushTypes';

export type { WebPushPhase, WebPushStatus } from './webPushTypes';

export const DEFAULT_WEB_PUSH_STATUS: WebPushStatus = {
  phase: 'native',
  label: '由系统通知管理',
  detail: '原生版本使用 iOS 或 Android 的系统通知通道。',
  canEnable: false,
};

export async function getWebPushStatus(): Promise<WebPushStatus> {
  return DEFAULT_WEB_PUSH_STATUS;
}

export async function enableWebPush(_input: {
  relayUrl: string;
  deviceId: string;
  deviceSecret: string;
}): Promise<WebPushStatus> {
  return DEFAULT_WEB_PUSH_STATUS;
}

export async function syncWebPush(_input: {
  relayUrl: string;
  deviceId: string;
  deviceSecret: string;
}): Promise<WebPushStatus> {
  return DEFAULT_WEB_PUSH_STATUS;
}

export async function disableWebPush(): Promise<void> {}

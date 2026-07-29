import type {
  NotificationSessionListener,
  PushRegistrationResult,
} from './notifications';

export async function registerForPushNotifications(): Promise<PushRegistrationResult> {
  return {
    token: null,
    message:
      '已连接私有 Relay。你可以在“设置 → 后台通知”中明确启用网页后台通知。',
  };
}

export async function getInitialNotificationSessionRef(): Promise<null> {
  return null;
}

export function listenForNotificationSession(
  _listener: NotificationSessionListener,
): () => void {
  return () => undefined;
}

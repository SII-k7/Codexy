import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

export interface PushRegistrationResult {
  token: string | null;
  message: string;
}

export type NotificationSessionListener = (sessionRef: string) => void;

let handlerConfigured = false;

function configureForegroundNotifications(): void {
  if (handlerConfigured) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
  handlerConfigured = true;
}

function easProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as
    | { eas?: { projectId?: string } }
    | undefined;
  return Constants.easConfig?.projectId ?? extra?.eas?.projectId ?? null;
}

export async function registerForPushNotifications(): Promise<PushRegistrationResult> {
  configureForegroundNotifications();

  if (!Device.isDevice) {
    return {
      token: null,
      message: '模拟器使用应用内轮询；系统推送需要 iOS 或 Android 真机。',
    };
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('codex-events', {
      name: 'Codex 状态',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 180, 100, 180],
      lightColor: '#111111',
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== 'granted') {
    return {
      token: null,
      message: '通知权限尚未开启；应用前台仍会同步 Codex 状态。',
    };
  }

  const projectId = easProjectId();
  if (!projectId) {
    return {
      token: null,
      message: '尚未绑定 EAS Project ID；当前先使用应用内轮询。',
    };
  }

  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  return {
    token,
    message: '系统推送已准备好。',
  };
}

function sessionRefFromResponse(
  response: Notifications.NotificationResponse | null,
): string | null {
  const value = response?.notification.request.content.data?.session_ref;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function getInitialNotificationSessionRef(): Promise<
  string | null
> {
  return sessionRefFromResponse(
    await Notifications.getLastNotificationResponseAsync(),
  );
}

export function listenForNotificationSession(
  listener: NotificationSessionListener,
): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      const sessionRef = sessionRefFromResponse(response);
      if (sessionRef) listener(sessionRef);
    },
  );
  return () => subscription.remove();
}

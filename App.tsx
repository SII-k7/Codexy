import { StatusBar } from 'expo-status-bar';
import { hostKey } from './src/fleet';
import { createLiveSync } from './src/liveSync';
import { bindForegroundSync } from './src/foregroundSync';
import { watchRelayChanges } from './src/relay';
import { createPromptSender } from './src/promptDelivery';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FRESHNESS_MS } from './src/fleet';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  attentionPriorityFor,
  buildAttentionQueue,
} from './src/attention';
import { AttentionQueue } from './src/components/AttentionQueue';
import { CodexSessionCard } from './src/components/CodexSessionCard';
import { CodexSessionScreen } from './src/components/CodexSessionScreen';
import { SpringPressable } from './src/components/SpringPressable';
import {
  getInitialNotificationSessionRef,
  listenForNotificationSession,
  registerForPushNotifications,
} from './src/notifications';
import {
  RelayError,
  acknowledgeEvent,
  cancelRemotePrompt,
  deleteDevice,
  getAgentSessions,
  getRelaySnapshot,
  getDeviceStatus,
  getEvents,
  getRemotePromptCommands,
  getSessionControl,
  getSessionRuntime,
  updateSessionGoal,
  getSessionReplySummary,
  normalizeRelayUrl,
  registerDevice,
  renewPairingCode,
  runSessionControlAction,
  sendRemotePrompt,
  sendTestNotification,
  updateDevicePreferences,
  updateSessionControl,
} from './src/relay';
import {
  clearAllCodexyStorage,
  loadHiddenSessionRefs,
  loadNotificationTestConfirmed,
  loadSavedDevice,
  saveDevice,
  saveHiddenSessionRefs,
  saveNotificationTestConfirmed,
} from './src/storage';
import {
  attentionEligibleSessions as filterAttentionEligibleSessions,
  visibleSessionTracks,
} from './src/sessionVisibility';
import {
  DEFAULT_WEB_PUSH_STATUS,
  disableWebPush,
  enableWebPush,
  getWebPushStatus,
  requiresStandaloneInstall,
  resetExpiredWebPush,
  syncWebPush,
} from './src/webPush';
import type { WebPushStatus } from './src/webPushTypes';
import type {
  AgentEvent,
  AgentSession,
  CodexControlAction,
  CodexControlActionResult,
  CodexControlSnapshot,
  CodexReplySummary,
  DevicePreferences,
  NotificationLevel,
  NotificationTone,
  RemoteControlHealth,
  RemotePromptCommand,
  RemotePromptMode,
  SavedDevice,
} from './src/types';

type MainTab = 'workbench' | 'settings';
type SessionFilter = 'all' | 'attention' | 'running' | 'review';

interface CachedReplySummary {
  sessionUpdatedAt: string;
  summary: CodexReplySummary;
}

const SESSION_FILTERS: Array<{
  id: SessionFilter;
  label: string;
}> = [
  { id: 'all', label: '全部' },
  { id: 'attention', label: '待接棒' },
  { id: 'running', label: '运行中' },
  { id: 'review', label: '待复核' },
];


const DEFAULT_NOTIFICATION_PREFERENCES: DevicePreferences = {
  notification_tone: 'calm',
  notification_level: 'important',
};

const NOTIFICATION_TONES: Array<{
  id: NotificationTone;
  label: string;
}> = [
  { id: 'calm', label: '克制' },
  { id: 'direct', label: '直接' },
  { id: 'playful', label: '有点人味' },
];

const NOTIFICATION_LEVELS: Array<{
  id: NotificationLevel;
  label: string;
  detail: string;
}> = [
  { id: 'decisions', label: '只推需要我', detail: '需要决定或运行失败' },
  {
    id: 'important',
    label: '重要节点',
    detail: '需要我、本轮结束、任务或会话完成',
  },
  { id: 'all', label: '全部状态', detail: '包含开始与子任务更新' },
];

function notificationPreview(tone: NotificationTone): {
  title: string;
  body: string;
} {
  if (tone === 'direct') {
    return {
      title: 'Codex：需要你确认',
      body: 'research-agent · 是否允许写入新的实验分析文件？',
    };
  }
  if (tone === 'playful') {
    return {
      title: '轮到你接棒了',
      body: 'research-agent · Codex 在这里等你的决定。',
    };
  }
  return {
    title: '有一件事等你决定',
    body: 'research-agent · 是否允许写入新的实验分析文件？',
  };
}

function requestedSessionFromUrl(): string | null {
  if (Platform.OS !== 'web') return null;
  const search = (
    globalThis as { location?: { search?: string } }
  ).location?.search;
  if (!search) return null;
  return new URLSearchParams(search).get('session');
}

function inferDefaultRelayUrl(): string {
  if (process.env.EXPO_PUBLIC_RELAY_URL) {
    return process.env.EXPO_PUBLIC_RELAY_URL;
  }
  if (Platform.OS === 'web') {
    const location = (
      globalThis as {
        location?: { hostname?: string; origin?: string; protocol?: string };
      }
    ).location;
    if (location?.protocol === 'https:' && location.origin) {
      return location.origin;
    }
    if (
      location?.hostname &&
      !['localhost', '127.0.0.1'].includes(location.hostname)
    ) {
      return `http://${location.hostname}:8797`;
    }
  }
  return 'http://127.0.0.1:8797';
}

function createDeviceId(): string {
  return `codexy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createCommandKey(): string {
  return `codexy-mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function createControlKey(action: string): string {
  return `codexy-control-${action}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function previewControlSnapshot(
  session: AgentSession,
): CodexControlSnapshot {
  const active = session.state === 'working';
  return {
    session_ref: session.session_ref,
    control_status: 'ready',
    session_state: active ? 'active' : 'idle',
    model: 'gpt-5.6-sol',
    reasoning_effort: 'medium',
    approval_policy: 'on-request',
    permission_profile: 'workspace-write',
    settings_apply_to: 'subsequent_turns',
    models: [
      {
        id: 'gpt-5.6-sol',
        display_name: 'GPT-5.6 Sol',
        description: '前沿 Agent 编码模型，适合复杂工程推进。',
        is_default: true,
        supported_efforts: [
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
          'ultra',
        ],
        default_effort: 'medium',
      },
      {
        id: 'gpt-5.6-terra',
        display_name: 'GPT-5.6 Terra',
        description: '平衡速度与深度的日常编码模型。',
        is_default: false,
        supported_efforts: [
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
          'ultra',
        ],
        default_effort: 'medium',
      },
      {
        id: 'gpt-5.6-luna',
        display_name: 'GPT-5.6 Luna',
        description: '轻量而灵活，适合快速迭代与检查。',
        is_default: false,
        supported_efforts: [
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
        ],
        default_effort: 'medium',
      },
    ],
    rate_limit: {
      primary: {
        used_percent: 23,
        window_minutes: 300,
        resets_at: new Date(Date.now() + 97 * 60 * 1000).toISOString(),
      },
      secondary: null,
    },
    available_actions: {
      status: true,
      compact: !active,
      review: !active,
      interrupt: active,
    },
    refreshed_at: new Date().toISOString(),
  };
}

function previewReplySummary(
  session: AgentSession,
): CodexReplySummary {
  const researchSession = session.project_alias === 'research-agent';
  return {
    available: true,
    session_ref: session.session_ref,
    current_turn_active: session.state === 'working',
    reason: null,
    turn_status: 'completed',
    completed_at: new Date(Date.now() - 7 * 60 * 1000).toISOString(),
    headline: researchSession
      ? '已完成上一轮失败样本分组，规划错误是目前最明显的问题。'
      : '已完成移动端界面调整，并通过构建与基础交互检查。',
    highlights: researchSession
      ? [
          {
            kind: 'outcome',
            label: '完成',
            text: '样本已按感知、规划和工具调用三类整理。',
          },
          {
            kind: 'verification',
            label: '验证',
            text: '所有结论都保留了对应样本，便于回到原始结果核对。',
          },
          {
            kind: 'next',
            label: '下一步',
            text: '建议先针对规划错误做一轮最小消融实验。',
          },
        ]
      : [
          {
            kind: 'verification',
            label: '验证',
            text: '类型检查和 Relay 自动化测试均已通过。',
          },
          {
            kind: 'attention',
            label: '注意',
            text: '仍需在真实 iPhone 上确认通知深链和触控手感。',
          },
        ],
    summary_method: 'local_extract',
    source_characters: researchSession ? 682 : 438,
    source_truncated: false,
    raw_response_exposed: false,
    persisted: false,
    generated_at: new Date().toISOString(),
  };
}

function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatSyncTimestamp(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function pairingExpiryStatus(value: string | null): {
  expired: boolean;
  label: string;
} {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return { expired: true, label: '有效期未知，请生成新配对码' };
  }
  const remaining = timestamp - Date.now();
  if (remaining <= 0) {
    return { expired: true, label: '配对码已过期' };
  }
  return {
    expired: false,
    label: `约 ${Math.max(1, Math.ceil(remaining / 60_000))} 分钟后失效`,
  };
}

function BottomNavigation(props: {
  active: MainTab;
  onChange: (tab: MainTab) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.bottomNavigation}>
      {(
        [
          ['workbench', '轨道'],
          ['settings', '设置'],
        ] as const
      ).map(([id, label]) => {
        const active = props.active === id;
        return (
          <SpringPressable
            accessibilityLabel={label}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            key={id}
            onPress={() => props.onChange(id)}
            pressedScale={0.96}
            style={styles.bottomTab}
          >
            <Text
              accessible={false}
              style={[
                styles.bottomTabDot,
                active && styles.bottomTabTextActive,
              ]}
            >
              {active ? '●' : '○'}
            </Text>
            <Text
              accessible={false}
              style={[
                styles.bottomTabText,
                active && styles.bottomTabTextActive,
              ]}
            >
              {label}
            </Text>
          </SpringPressable>
        );
      })}
    </View>
  );
}

const reviewedPromptSender = createPromptSender(sendRemotePrompt,
  (error) => error instanceof RelayError && error.status !== undefined && error.status >= 400 && error.status < 500);

export default function App(props: {
  initialDevice?: SavedDevice;
  initialSession?: AgentSession;
  onExit?: () => void;
  onDeviceRemoved?: () => Promise<void>;
} = {}) {
  const storageScope = props.initialDevice ? hostKey(props.initialDevice) : undefined;
  const [booting, setBooting] = useState(true);
  const [activeTab, setActiveTab] = useState<MainTab>('workbench');
  const [savedDevice, setSavedDevice] = useState<SavedDevice | null>(props.initialDevice ?? null);
  const [previewMode, setPreviewMode] = useState(false);
  const [relayInput, setRelayInput] = useState(inferDefaultRelayUrl());
  const [showAdvancedRelay, setShowAdvancedRelay] = useState(false);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');
  const [connecting, setConnecting] = useState(false);
  const [paired, setPaired] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<string | null>(null);
  const [pairingRenewBusy, setPairingRenewBusy] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionNote, setConnectionNote] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>(props.initialSession ? [props.initialSession] : []);
  const [hiddenSessionRefs, setHiddenSessionRefs] = useState<string[]>([]);
  const [commands, setCommands] = useState<RemotePromptCommand[]>([]);
  const [replySummaryCache, setReplySummaryCache] = useState<
    Record<string, CachedReplySummary>
  >({});
  const [summarizingSessionRef, setSummarizingSessionRef] = useState<
    string | null
  >(null);
  const [selectedSessionRef, setSelectedSessionRef] = useState<string | null>(
    null,
  );
  const [pendingHiddenSession, setPendingHiddenSession] =
    useState<AgentSession | null>(null);
  const [resetConfirmationVisible, setResetConfirmationVisible] =
    useState(false);
  const [requestedSessionRef, setRequestedSessionRef] = useState<string | null>(
    () => props.initialSession?.session_ref ?? requestedSessionFromUrl(),
  );
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const refreshEpochRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const previewControlsRef = useRef(
    new Map<string, CodexControlSnapshot>(),
  );
  const [refreshing, setRefreshing] = useState(false);
  const [webPushStatus, setWebPushStatus] = useState<WebPushStatus>(
    DEFAULT_WEB_PUSH_STATUS,
  );
  const [webPushBusy, setWebPushBusy] = useState(false);
  const [notificationTestBusy, setNotificationTestBusy] = useState(false);
  const [notificationTestSent, setNotificationTestSent] = useState(false);
  const [notificationTestConfirmed, setNotificationTestConfirmed] =
    useState(false);
  const [notificationPreferences, setNotificationPreferences] =
    useState<DevicePreferences>(DEFAULT_NOTIFICATION_PREFERENCES);
  const [notificationPreferencesBusy, setNotificationPreferencesBusy] =
    useState(false);
  const [remoteControl, setRemoteControl] = useState<RemoteControlHealth>({
    state: 'disabled',
    detail: '电脑端尚未启用 Codex 控制桥接。',
    endpoint: null,
  });

  useEffect(() => {
    void Promise.all([
      props.initialDevice ? Promise.resolve(props.initialDevice) : props.onExit ? Promise.resolve(null) : loadSavedDevice(),
      loadHiddenSessionRefs(storageScope).catch(() => []),
    ])
      .then(([device, hiddenRefs]) => {
        setSavedDevice(device);
        setHiddenSessionRefs(hiddenRefs);
        setRelayInput(device?.relayUrl ?? inferDefaultRelayUrl());
      })
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (previewMode) {
      setNotificationTestConfirmed(true);
      return;
    }
    if (!savedDevice) {
      setNotificationTestConfirmed(false);
      return;
    }
    let active = true;
    void loadNotificationTestConfirmed(savedDevice).then((confirmed) => {
      if (active) setNotificationTestConfirmed(confirmed);
    });
    return () => {
      active = false;
    };
  }, [previewMode, savedDevice]);

  useEffect(() => {
    void getInitialNotificationSessionRef().then((sessionRef) => {
      if (sessionRef) setRequestedSessionRef(sessionRef);
    });
    return listenForNotificationSession(setRequestedSessionRef);
  }, []);

  useEffect(() => {
    if (booting) return;
    let active = true;
    const statusPromise = savedDevice
      ? syncWebPush({
          relayUrl: savedDevice.relayUrl,
          deviceId: savedDevice.deviceId,
          deviceSecret: savedDevice.deviceSecret,
        })
      : getWebPushStatus();
    void statusPromise.then((status) => {
      if (!active) return;
      setWebPushStatus(status);
      if (!previewMode && status.phase !== 'subscribed') {
        setNotificationTestSent(false);
        setNotificationTestConfirmed(false);
        if (savedDevice) {
          void saveNotificationTestConfirmed(savedDevice, false).catch(
            () => undefined,
          );
        }
      }
    });
    return () => {
      active = false;
    };
  }, [booting, previewMode, savedDevice]);

  useEffect(() => {
    refreshEpochRef.current += 1;
    refreshInFlightRef.current = null;
  }, [savedDevice?.deviceId, savedDevice?.relayUrl]);

  const refresh = useCallback(async () => {
    if (!savedDevice) return;
    if (refreshInFlightRef.current) {
      await refreshInFlightRef.current;
      return;
    }
    const requestEpoch = refreshEpochRef.current;
    const request = (async () => {
      try {
        const snapshot = await getRelaySnapshot(savedDevice);
        if (snapshot.hub_online === false) throw new RelayError('电脑已离线，保留的任务进度待确认；当前无法发送指令。');
        const { status, sessions: sessionResult, commands: commandResult } = snapshot;
        const eventResult = snapshot;

        if (requestEpoch !== refreshEpochRef.current) return;
        if (eventResult.events.length) {
          setEvents((current) => {
            const byId = new Map(
              current.map((event) => [event.event_id, event]),
            );
            for (const event of eventResult.events) {
              if (event.source === 'codex') byId.set(event.event_id, event);
            }
            return [...byId.values()]
              .sort((left, right) => right.cursor - left.cursor)
              .slice(0, 30);
          });
        }
        cursorRef.current = eventResult.next_cursor;
        setCursor(eventResult.next_cursor);
        setPaired(status.paired);
        setPairingCode(status.pairing_code);
        setPairingExpiresAt(status.pairing_expires_at);
        setNotificationPreferences(
          status.preferences ?? DEFAULT_NOTIFICATION_PREFERENCES,
        );
        setRemoteControl(
          status.remote_control ?? {
            state: 'disabled',
            detail: '当前 Relay 尚未启用手机控制。',
            endpoint: null,
          },
        );
        setSessions(
          sessionResult.filter((session) => session.source === 'codex'),
        );
        setCommands(commandResult);
        setLastSyncAt(Date.now());
        setSyncError(null);
        setConnectionError(null);
      } catch (error) {
        if (requestEpoch !== refreshEpochRef.current) return;
        const message =
          error instanceof Error ? error.message : 'Codex 状态同步失败。';
        setSyncError(message);
        setConnectionError(message);
      }
    })();
    refreshInFlightRef.current = request;
    try {
      await request;
    } finally {
      if (refreshInFlightRef.current === request) {
        refreshInFlightRef.current = null;
      }
    }
  }, [savedDevice]);

  useEffect(() => {
    if (!savedDevice || previewMode) return;
    const feed = createLiveSync({
      watch: (revision, signal) => watchRelayChanges(savedDevice, revision, signal), refresh,
      onError: (error) => { setSyncError(error.message); setConnectionError(error.message); },
    });
    const unbind = bindForegroundSync((active) => {
      if (!active) setSyncError('页面已暂停同步，返回后刷新。');
      feed.setActive(active);
    });
    return () => { unbind(); feed.close(); };
  }, [refresh, savedDevice, previewMode]);

  const retryRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const renewPairing = useCallback(async () => {
    if (!savedDevice || previewMode || paired) return;
    setPairingRenewBusy(true);
    setConnectionError(null);
    try {
      const renewal = await renewPairingCode(savedDevice);
      setPairingCode(renewal.pairing_code);
      setPairingExpiresAt(renewal.pairing_expires_at);
      setConnectionNote('已生成新的配对码；旧配对码立即失效。');
    } catch (error) {
      if (error instanceof RelayError && error.status === 409) {
        setConnectionNote('电脑端已完成配对，正在重新确认状态。');
        await refresh();
      } else if (error instanceof RelayError && error.status === 429) {
        setConnectionError('生成配对码太频繁，请稍后再试。');
      } else if (error instanceof RelayError && error.status === 404) {
        setConnectionError(
          '当前 Relay 还不支持刷新配对码，请先在电脑运行 codexy doctor。',
        );
      } else {
        setConnectionError(
          error instanceof Error ? error.message : '无法生成新的配对码。',
        );
      }
    } finally {
      setPairingRenewBusy(false);
    }
  }, [paired, previewMode, refresh, savedDevice]);

  const connect = useCallback(async () => {
    if (requiresStandaloneInstall()) {
      setConnectionError(
        '请先在 Safari 点“分享”→“添加到主屏幕”，再从主屏幕打开 Codexy。',
      );
      return;
    }
    const relayUrl = normalizeRelayUrl(relayInput);
    if (!relayUrl) {
      setConnectionError('请输入 Codexy Relay 地址。');
      return;
    }
    setConnecting(true);
    setConnectionError(null);
    try {
      const push = await registerForPushNotifications();
      const sameRelay = savedDevice?.relayUrl === relayUrl;
      const deviceId = sameRelay ? savedDevice.deviceId : createDeviceId();
      const registration = await registerDevice({
        relayUrl,
        deviceId,
        deviceSecret: sameRelay ? savedDevice.deviceSecret : undefined,
        expoPushToken: push.token,
        platform: Platform.OS,
      });
      const nextDevice = {
        relayUrl,
        deviceId: registration.device_id,
        deviceSecret: registration.device_secret,
      };
      await saveDevice(nextDevice);
      setSavedDevice(nextDevice);
      setPaired(registration.paired);
      setPairingCode(registration.pairing_code);
      setPairingExpiresAt(registration.pairing_expires_at);
      setConnectionNote(push.message);
      setSessions([]);
      setEvents([]);
      setCommands([]);
      setReplySummaryCache({});
      setSummarizingSessionRef(null);
      setLastSyncAt(null);
      setSyncError(null);
      cursorRef.current = 0;
      setCursor(0);
    } catch (error) {
      setConnectionError(
        error instanceof RelayError || error instanceof Error
          ? error.message
          : '无法连接 Codexy Relay。',
      );
    } finally {
      setConnecting(false);
    }
  }, [relayInput, savedDevice]);

  const resetConnection = useCallback(async () => {
    if (!previewMode && savedDevice) {
      setConnecting(true);
      setConnectionError(null);
      try {
        await deleteDevice({
          relayUrl: savedDevice.relayUrl,
          deviceId: savedDevice.deviceId,
          deviceSecret: savedDevice.deviceSecret,
        });
      } catch (error) {
        if (!(error instanceof RelayError && error.status === 404)) {
          setConnectionError(
            error instanceof Error
              ? `无法从电脑撤销设备：${error.message}`
              : '无法从电脑撤销设备；当前连接已保留。',
          );
          setConnecting(false);
          return;
        }
      }
      await disableWebPush(savedDevice);
      setConnecting(false);
    }
    if (props.onDeviceRemoved) { await props.onDeviceRemoved(); return; }
    await clearAllCodexyStorage();
    setSavedDevice(null);
    setPreviewMode(false);
    setPaired(false);
    setPairingCode(null);
    setPairingExpiresAt(null);
    setPairingRenewBusy(false);
    setEvents([]);
    setSessions([]);
    setHiddenSessionRefs([]);
    setCommands([]);
    setReplySummaryCache({});
    setSummarizingSessionRef(null);
    setConnectionError(null);
    setConnectionNote('');
    setLastSyncAt(null);
    setSyncError(null);
    setNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
    setNotificationTestBusy(false);
    setNotificationTestSent(false);
    setNotificationTestConfirmed(false);
    setSelectedSessionRef(null);
    setPendingHiddenSession(null);
    setResetConfirmationVisible(false);
    setActiveTab('workbench');
    setSessionFilter('all');
    setShowAdvancedRelay(false);
    previewControlsRef.current.clear();
    cursorRef.current = 0;
    setCursor(0);
  }, [previewMode, savedDevice]);

  const confirmResetConnection = useCallback(() => {
    if (previewMode) {
      void resetConnection();
      return;
    }
    setResetConfirmationVisible(true);
  }, [previewMode, resetConnection]);

  const saveNotificationPreferences = useCallback(
    async (patch: Partial<DevicePreferences>) => {
      const next = { ...notificationPreferences, ...patch };
      if (previewMode) {
        setNotificationPreferences(next);
        setConnectionNote('通知预览已更新；体验模式不会发送真实横幅。');
        return;
      }
      if (!savedDevice) return;
      setNotificationPreferencesBusy(true);
      try {
        const saved = await updateDevicePreferences({
          relayUrl: savedDevice.relayUrl,
          deviceId: savedDevice.deviceId,
          deviceSecret: savedDevice.deviceSecret,
          preferences: patch,
        });
        setNotificationPreferences(saved);
        setConnectionNote('通知策略已保存到这台 iPhone。');
        setConnectionError(null);
      } catch (error) {
        setConnectionError(
          error instanceof Error ? error.message : '通知策略保存失败。',
        );
      } finally {
        setNotificationPreferencesBusy(false);
      }
    },
    [notificationPreferences, previewMode, savedDevice],
  );

  const activateWebPush = useCallback(async () => {
    if (!savedDevice || previewMode) return;
    setWebPushBusy(true);
    setConnectionError(null);
    try {
      const status = await enableWebPush({
        relayUrl: savedDevice.relayUrl,
        deviceId: savedDevice.deviceId,
        deviceSecret: savedDevice.deviceSecret,
      });
      setWebPushStatus(status);
      setConnectionNote(status.detail);
      if (status.phase === 'subscribed') {
        setNotificationTestSent(false);
        setNotificationTestConfirmed(false);
        await saveNotificationTestConfirmed(savedDevice, false);
      }
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : '无法启用后台通知。',
      );
    } finally {
      setWebPushBusy(false);
    }
  }, [previewMode, savedDevice]);

  const testNotification = useCallback(async () => {
    if (previewMode) {
      setNotificationTestSent(true);
      setConnectionNote('体验模式只演示通知流程，不会发送真实系统通知。');
      return;
    }
    if (!savedDevice || webPushStatus.phase !== 'subscribed') return;
    setNotificationTestBusy(true);
    setConnectionError(null);
    try {
      const result = await sendTestNotification(savedDevice);
      if (!result.delivered) {
        const subscriptionExpired =
          result.delivery_status === 'expired' ||
          result.push_channels.web === 'expired';
        let detail =
          result.delivery_status === 'not_configured'
            ? 'Relay 尚未配置可用的推送通道，请在电脑运行 codexy doctor。'
            : '测试通知发送失败，请稍后重试或在电脑运行 codexy doctor。';
        if (subscriptionExpired) {
          const recoveryStatus = await resetExpiredWebPush(savedDevice);
          setWebPushStatus(recoveryStatus);
          setNotificationTestConfirmed(false);
          await saveNotificationTestConfirmed(savedDevice, false);
          detail = recoveryStatus.detail;
        }
        setNotificationTestSent(false);
        setConnectionError(detail);
        return;
      }
      setNotificationTestSent(true);
      setNotificationTestConfirmed(false);
      await saveNotificationTestConfirmed(savedDevice, false);
      setConnectionNote(
        result.delivery_status === 'partial'
          ? '测试通知已从一个可用通道发出；看到系统横幅后，请确认收到。'
          : '测试通知已发出；看到系统横幅后，请确认收到。',
      );
    } catch (error) {
      setNotificationTestSent(false);
      setConnectionError(
        error instanceof RelayError && error.status === 429
          ? '测试太频繁，请稍后再试。'
          : error instanceof Error
            ? error.message
            : '无法发送测试通知。',
      );
    } finally {
      setNotificationTestBusy(false);
    }
  }, [previewMode, savedDevice, webPushStatus.phase]);

  const confirmNotificationTest = useCallback(async () => {
    try {
      if (!previewMode && savedDevice) {
        await saveNotificationTestConfirmed(savedDevice, true);
      }
      setNotificationTestConfirmed(true);
      setConnectionError(null);
      setConnectionNote('通知链路已验证；之后可以放心把 Codex 放到后台。');
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : '无法保存通知确认状态。',
      );
    }
  }, [previewMode, savedDevice]);

  const acknowledge = useCallback(
    async (event: AgentEvent) => {
      if (previewMode) {
        const acknowledgedAt = new Date().toISOString();
        setEvents((current) =>
          current.map((candidate) =>
            candidate.event_id === event.event_id
              ? { ...candidate, acknowledged_at: acknowledgedAt }
              : candidate,
          ),
        );
        setSessions((current) =>
          current.map((session) =>
            session.session_ref === event.session_ref
              ? {
                  ...session,
                  acknowledged_at: acknowledgedAt,
                }
              : session,
          ),
        );
        setConnectionNote('已看到提醒；Codex 仍在等待你从电脑端处理。');
        return;
      }
      if (!savedDevice) return;
      try {
        await acknowledgeEvent(
          savedDevice.relayUrl,
          savedDevice.deviceId,
          savedDevice.deviceSecret,
          event.event_id,
        );
        await refresh();
      } catch (error) {
        setConnectionError(
          error instanceof Error ? error.message : '确认状态失败。',
        );
      }
    },
    [previewMode, refresh, savedDevice],
  );

  const sendPromptToSession = useCallback(
    async (
      session: AgentSession,
      prompt: string,
      mode: RemotePromptMode,
    ): Promise<RemotePromptCommand> => {
      if (previewMode) {
        const now = new Date().toISOString();
        const shouldWait =
          mode === 'queue' &&
          ['working', 'needs_you'].includes(session.state);
        const command: RemotePromptCommand = {
          command_id: `codexy-demo-${Date.now()}`,
          session_ref: session.session_ref,
          mode,
          status: shouldWait ? 'waiting' : 'sent',
          status_detail:
            shouldWait
              ? '已排到当前回合之后；尚未交给 Codex，可随时撤回。'
              : mode === 'queue'
                ? '体验 Prompt 已作为下一轮送达。'
              : '体验 Prompt 已插入当前回合。',
          created_at: now,
          updated_at: now,
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          prompt_length: prompt.length,
          turn_id: `demo-turn-${Date.now()}`,
        };
        setCommands((current) => [
          command,
          ...current.filter(
            (candidate) =>
              candidate.session_ref !== session.session_ref,
          ),
        ]);
        if (!shouldWait) {
          setSessions((current) =>
            current.map((candidate) =>
              candidate.session_ref === session.session_ref
                ? {
                    ...candidate,
                    state: 'working',
                    summary: '已从手机收到新的 Prompt。',
                    updated_at: now,
                  }
                : candidate,
            ),
          );
        }
        return command;
      }
      if (!savedDevice) throw new RelayError('尚未连接 Codexy Relay。');
      const command = await reviewedPromptSender.submit({
        relayUrl: savedDevice.relayUrl,
        deviceId: savedDevice.deviceId,
        deviceSecret: savedDevice.deviceSecret,
        sessionRef: session.session_ref,
        prompt,
        mode,
      });
      setCommands((current) => [
        command,
        ...current.filter(
          (candidate) => candidate.command_id !== command.command_id,
        ),
      ]);
      return command;
    },
    [previewMode, savedDevice],
  );

  const cancelPromptCommand = useCallback(
    async (commandId: string): Promise<RemotePromptCommand> => {
      if (previewMode) {
        const updatedAt = new Date().toISOString();
        let canceled: RemotePromptCommand | null = null;
        setCommands((current) =>
          current.map((command) => {
            if (command.command_id !== commandId) return command;
            canceled = {
              ...command,
              status: 'canceled',
              status_detail: '已从手机撤回，未交给 Codex。',
              updated_at: updatedAt,
            };
            return canceled;
          }),
        );
        if (!canceled) throw new RelayError('没有找到这条待发指令。');
        return canceled;
      }
      if (!savedDevice) throw new RelayError('尚未连接 Codexy Relay。');
      const command = await cancelRemotePrompt(
        savedDevice.relayUrl,
        savedDevice.deviceId,
        savedDevice.deviceSecret,
        commandId,
      );
      setCommands((current) =>
        current.map((candidate) =>
          candidate.command_id === command.command_id ? command : candidate,
        ),
      );
      return command;
    },
    [previewMode, savedDevice],
  );

  const loadControlForSession = useCallback(
    async (session: AgentSession): Promise<CodexControlSnapshot> => {
      if (previewMode) {
        const cached = previewControlsRef.current.get(
          session.session_ref,
        );
        if (cached) return cached;
        const created = previewControlSnapshot(session);
        previewControlsRef.current.set(session.session_ref, created);
        return created;
      }
      if (!savedDevice) throw new RelayError('尚未连接 Codexy Relay。');
      return getSessionControl({
        relayUrl: savedDevice.relayUrl,
        deviceId: savedDevice.deviceId,
        deviceSecret: savedDevice.deviceSecret,
        sessionRef: session.session_ref,
      });
    },
    [previewMode, savedDevice],
  );

  const loadReplySummaryForSession = useCallback(
    async (session: AgentSession): Promise<CodexReplySummary> => {
      const summary = previewMode
        ? previewReplySummary(session)
        : savedDevice
          ? await getSessionReplySummary({
              relayUrl: savedDevice.relayUrl,
              deviceId: savedDevice.deviceId,
              deviceSecret: savedDevice.deviceSecret,
              sessionRef: session.session_ref,
            })
          : null;
      if (!summary) throw new RelayError('尚未连接 Codexy Relay。');
      setReplySummaryCache((current) => ({
        ...current,
        [session.session_ref]: {
          sessionUpdatedAt: `${session.updated_at}:${session.state}`,
          summary,
        },
      }));
      return summary;
    },
    [previewMode, savedDevice],
  );

  const updateControlForSession = useCallback(
    async (
      session: AgentSession,
      model: string,
      reasoningEffort: string,
    ): Promise<CodexControlSnapshot> => {
      if (previewMode) {
        const current =
          previewControlsRef.current.get(session.session_ref) ??
          previewControlSnapshot(session);
        const selected = current.models.find(
          (candidate) => candidate.id === model,
        );
        if (
          !selected ||
          !selected.supported_efforts.includes(reasoningEffort)
        ) {
          throw new RelayError('所选模型不支持这个思考强度。');
        }
        const next: CodexControlSnapshot = {
          ...current,
          model,
          reasoning_effort: reasoningEffort,
          refreshed_at: new Date().toISOString(),
        };
        previewControlsRef.current.set(session.session_ref, next);
        return next;
      }
      if (!savedDevice) throw new RelayError('尚未连接 Codexy Relay。');
      return updateSessionControl({
        relayUrl: savedDevice.relayUrl,
        deviceId: savedDevice.deviceId,
        deviceSecret: savedDevice.deviceSecret,
        sessionRef: session.session_ref,
        model,
        reasoningEffort,
        idempotencyKey: createControlKey('settings'),
      });
    },
    [previewMode, savedDevice],
  );

  const runControlForSession = useCallback(
    async (
      session: AgentSession,
      action: CodexControlAction,
    ): Promise<CodexControlActionResult> => {
      if (previewMode) {
        const current =
          previewControlsRef.current.get(session.session_ref) ??
          previewControlSnapshot(session);
        const stopped = action === 'interrupt';
        const next: CodexControlSnapshot = {
          ...current,
          session_state: stopped ? 'idle' : current.session_state,
          available_actions: stopped
            ? {
                status: true,
                compact: true,
                review: true,
                interrupt: false,
              }
            : current.available_actions,
          refreshed_at: new Date().toISOString(),
        };
        previewControlsRef.current.set(session.session_ref, next);
        if (stopped) {
          setSessions((currentSessions) =>
            currentSessions.map((candidate) =>
              candidate.session_ref === session.session_ref
                ? {
                    ...candidate,
                    state: 'interrupted',
                    summary: '已从手机停止当前 Codex 回合。',
                    updated_at: next.refreshed_at,
                  }
                : candidate,
            ),
          );
        }
        const detail: Record<CodexControlAction, string> = {
          status: '电脑端状态已经刷新。',
          compact: '已开始压缩上下文；完成后可继续下一轮。',
          review: '已开始审查未提交改动。',
          interrupt: '已请求停止当前回合。',
        };
        return {
          action,
          accepted: true,
          detail: detail[action],
          snapshot: next,
        };
      }
      if (!savedDevice) throw new RelayError('尚未连接 Codexy Relay。');
      return runSessionControlAction({
        relayUrl: savedDevice.relayUrl,
        deviceId: savedDevice.deviceId,
        deviceSecret: savedDevice.deviceSecret,
        sessionRef: session.session_ref,
        action,
        idempotencyKey: createControlKey(action),
      });
    },
    [previewMode, savedDevice],
  );

  const startPreview = useCallback(() => {
    const now = new Date().toISOString();
    const previewSessions: AgentSession[] = [
      {
        session_ref: 'sha256:111122223333444455556666',
        source: 'codex',
        project_alias: 'research-agent',
        state: 'working',
        summary: '正在整理实验结果与失败样本。',
        updated_at: now,
        control_status: 'ready',
        prompt_count: 5,
        prompts: [
          {
            prompt_id: 'preview-1',
            captured_at: now,
            text: '先读取当前实验结果，不要修改训练配置。',
          },
          {
            prompt_id: 'preview-2',
            captured_at: now,
            text: '按失败类型整理多模态 Agent 的评测样本。',
          },
          {
            prompt_id: 'preview-3',
            captured_at: now,
            text: '优先区分感知错误、规划错误和工具调用错误。',
          },
          {
            prompt_id: 'preview-4',
            captured_at: now,
            text: '所有结论都要能回到具体样本验证。',
          },
          {
            prompt_id: 'preview-5',
            captured_at: now,
            text: '完成后给出下一轮最小实验建议，但不要自动运行。',
          },
        ],
      },
      {
        session_ref: 'sha256:66667777888899990000aaaa',
        source: 'codex',
        project_alias: 'codexy-app',
        state: 'turn_finished',
        summary: '移动端本轮界面调整已经结束。',
        updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        control_status: 'ready',
        prompt_count: 3,
        prompts: [
          {
            prompt_id: 'preview-b-1',
            captured_at: now,
            text: '只保留 Codex 推送、Prompt 和思路整理。',
          },
          {
            prompt_id: 'preview-b-2',
            captured_at: now,
            text: '整体保持黑白、克制和高信息密度。',
          },
          {
            prompt_id: 'preview-b-3',
            captured_at: now,
            text: '不要加入内容流、Todo 或非必要增长功能。',
          },
        ],
      },
    ];
    previewControlsRef.current.clear();
    setReplySummaryCache(
      Object.fromEntries(
        previewSessions.map((session) => [
          session.session_ref,
          {
            sessionUpdatedAt: `${session.updated_at}:${session.state}`,
            summary: previewReplySummary(session),
          },
        ]),
      ),
    );
    setSummarizingSessionRef(null);
    previewControlsRef.current.set(
      previewSessions[0].session_ref,
      previewControlSnapshot(previewSessions[0]),
    );
    setPreviewMode(true);
    setPaired(true);
    setPairingCode(null);
    setPairingExpiresAt(null);
    setSessions(previewSessions);
    setEvents(
      previewSessions.map((session, index) => ({
        cursor: previewSessions.length - index,
        schema_version: '1.0',
        event_id: `codexy-preview-event-${index}`,
        dedupe_key: `codexy-preview-event-${index}`,
        occurred_at: session.updated_at,
        source: 'codex',
        state: session.state,
        event: 'preview.session',
        project_alias: session.project_alias,
        summary: session.summary,
        session_ref: session.session_ref,
      })),
    );
    setCommands([]);
    setRemoteControl({
      state: 'ready',
      detail: '体验模式中的 research-agent 可从手机发送 Prompt。',
      endpoint: 'localhost-only',
    });
    setConnectionNote('本地体验模式不会连接或上传任何 Codex 数据。');
    setLastSyncAt(Date.now());
    setSyncError(null);
    setNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
    setNotificationTestSent(false);
    setNotificationTestConfirmed(true);
    setConnectionError(null);
    setActiveTab('workbench');
  }, []);

  const simulateNeedsYou = useCallback(() => {
    const targetRef = 'sha256:111122223333444455556666';
    const now = new Date().toISOString();
    const event: AgentEvent = {
      cursor: cursor + 1,
      schema_version: '1.0',
      event_id: `codexy-preview-needs-${Date.now()}`,
      dedupe_key: `codexy-preview-needs-${Date.now()}`,
      occurred_at: now,
      source: 'codex',
      state: 'needs_you',
      event: 'PermissionRequest',
      project_alias: 'research-agent',
      summary: '需要确认：是否允许写入新的实验分析文件？',
      session_ref: targetRef,
    };
    setEvents((current) => [event, ...current]);
    setSessions((current) =>
      current.map((session) =>
        session.session_ref === targetRef
          ? {
              ...session,
              state: 'needs_you',
              summary: event.summary,
              updated_at: now,
              acknowledged_at: undefined,
            }
          : session,
      ),
    );
    setCursor(event.cursor);
    setConnectionNote('已模拟一条 Codex 手机推送。');
  }, [cursor]);

  const hideSessionFromWorkbench = useCallback((session: AgentSession) => {
    setPendingHiddenSession(session);
  }, []);

  const confirmHideSession = useCallback(async () => {
    if (!pendingHiddenSession) return;
    const session = pendingHiddenSession;
    if (hiddenSessionRefs.includes(session.session_ref)) {
      setPendingHiddenSession(null);
      return;
    }
    const next = [...hiddenSessionRefs, session.session_ref];
    try {
      const persisted = await saveHiddenSessionRefs(next, storageScope);
      setHiddenSessionRefs(persisted);
      setPendingHiddenSession(null);
      setConnectionError(null);
      setConnectionNote(
        `已隐藏 ${session.project_alias}。会话仍在电脑运行；若它需要你或运行失败，会重新出现在注意力队列。`,
      );
    } catch (error) {
      setConnectionError(
        error instanceof Error
          ? `无法保存隐藏偏好：${error.message}`
          : '无法保存隐藏偏好。',
      );
    }
  }, [hiddenSessionRefs, pendingHiddenSession]);

  const restoreHiddenSessions = useCallback(async () => {
    try {
      const persisted = await saveHiddenSessionRefs([], storageScope);
      setHiddenSessionRefs(persisted);
      setConnectionError(null);
      setConnectionNote('已恢复所有隐藏会话。');
    } catch (error) {
      setConnectionError(
        error instanceof Error
          ? `无法恢复隐藏会话：${error.message}`
          : '无法恢复隐藏会话。',
      );
    }
  }, []);

  const restoreHiddenSession = useCallback(
    async (sessionRef: string) => {
      const next = hiddenSessionRefs.filter((item) => item !== sessionRef);
      try {
        const persisted = await saveHiddenSessionRefs(next, storageScope);
        setHiddenSessionRefs(persisted);
        setConnectionError(null);
        setConnectionNote('已恢复这条会话。');
      } catch (error) {
        setConnectionError(
          error instanceof Error
            ? `无法恢复隐藏会话：${error.message}`
            : '无法恢复隐藏会话。',
        );
      }
    },
    [hiddenSessionRefs],
  );

  const orderedSessions = useMemo(
    () =>
      [...sessions].sort((left, right) => {
        const priorityDifference =
          attentionPriorityFor(right) - attentionPriorityFor(left);
        if (priorityDifference !== 0) return priorityDifference;
        return (
          new Date(right.updated_at).getTime() -
          new Date(left.updated_at).getTime()
        );
      }),
    [sessions],
  );
  const hiddenSessionSet = useMemo(
    () => new Set(hiddenSessionRefs),
    [hiddenSessionRefs],
  );
  const visibleOrderedSessions = useMemo(
    () => visibleSessionTracks(orderedSessions, hiddenSessionSet),
    [hiddenSessionSet, orderedSessions],
  );
  const hiddenSessions = useMemo(
    () =>
      orderedSessions.filter((session) =>
        hiddenSessionSet.has(session.session_ref),
      ),
    [hiddenSessionSet, orderedSessions],
  );
  const attentionEligibleSessions = useMemo(
    () =>
      filterAttentionEligibleSessions(
        orderedSessions,
        hiddenSessionSet,
      ),
    [hiddenSessionSet, orderedSessions],
  );
  const dashboardSummaries = useMemo(() => {
    const summaries: Record<string, CodexReplySummary> = {};
    for (const session of orderedSessions) {
      const cached = replySummaryCache[session.session_ref];
      if (cached?.sessionUpdatedAt === `${session.updated_at}:${session.state}`) {
        summaries[session.session_ref] = cached.summary;
      }
    }
    return summaries;
  }, [orderedSessions, replySummaryCache]);
  const attentionQueue = useMemo(
    () => buildAttentionQueue(attentionEligibleSessions, dashboardSummaries),
    [attentionEligibleSessions, dashboardSummaries],
  );
  const summarizeFromWorkbench = useCallback(
    async (sessionRef: string) => {
      const session = orderedSessions.find(
        (candidate) => candidate.session_ref === sessionRef,
      );
      if (!session) return;
      setSummarizingSessionRef(sessionRef);
      setConnectionError(null);
      try {
        const summary = await loadReplySummaryForSession(session);
        setConnectionNote(
          summary.available
            ? '已在电脑本机提炼最新回复；完整回复没有进入手机持久状态。'
            : '当前还没有可提炼的最终回复；完成本轮后可以再试。',
        );
      } catch (error) {
        setConnectionError(
          error instanceof Error
            ? error.message
            : '无法提炼这条 Agent 回复。',
        );
      } finally {
        setSummarizingSessionRef(null);
      }
    },
    [loadReplySummaryForSession, orderedSessions],
  );

  const primaryAttention = attentionQueue[0] ?? null;
  const filteredSessions = useMemo(
    () =>
      visibleOrderedSessions.filter((session) => {
        if (sessionFilter === 'attention') {
          return attentionPriorityFor(session) > 0;
        }
        if (sessionFilter === 'running') return session.state === 'working';
        if (sessionFilter === 'review') {
          return [
            'turn_finished',
            'subtask_completed',
            'completed',
            'failed',
          ].includes(session.state);
        }
        return true;
      }),
    [sessionFilter, visibleOrderedSessions],
  );
  const filterCounts: Record<SessionFilter, number> = {
    all: visibleOrderedSessions.length,
    attention: attentionQueue.length,
    running: visibleOrderedSessions.filter(
      (session) => session.state === 'working',
    ).length,
    review: visibleOrderedSessions.filter((session) =>
      ['turn_finished', 'subtask_completed', 'completed', 'failed'].includes(
        session.state,
      ),
    ).length,
  };
  const syncSnapshotTrusted =
    previewMode || (lastSyncAt !== null && syncError === null);
  const syncStatusUnknown = !syncSnapshotTrusted;
  const lastSuccessfulSyncLabel = lastSyncAt
    ? formatSyncTimestamp(lastSyncAt)
    : '尚无成功同步记录';
  const pairingExpiry = pairingExpiryStatus(pairingExpiresAt);
  const setupChecks = [
    {
      done:
        previewMode || (syncSnapshotTrusted && Boolean(savedDevice)),
      label: '手机已连接 Relay',
      unknown: syncStatusUnknown,
    },
    {
      done: previewMode || (syncSnapshotTrusted && paired),
      label: '桌面已完成配对',
      unknown: syncStatusUnknown,
    },
    {
      done:
        previewMode ||
        (syncSnapshotTrusted && webPushStatus.phase === 'subscribed'),
      label: '后台通知已订阅',
      unknown: syncStatusUnknown,
    },
    {
      done:
        previewMode ||
        (syncSnapshotTrusted &&
          webPushStatus.phase === 'subscribed' &&
          notificationTestConfirmed),
      label: '测试通知已确认',
      unknown: syncStatusUnknown,
    },
    {
      done:
        previewMode ||
        (syncSnapshotTrusted && remoteControl.state === 'ready'),
      label: '手机 Prompt 已就绪',
      unknown: syncStatusUnknown,
    },
  ];
  const setupCompleteCount = setupChecks.filter((step) => step.done).length;
  const notificationSample = notificationPreview(
    notificationPreferences.notification_tone,
  );
  const secondsSinceSync = lastSyncAt
    ? Math.max(0, Math.round((Date.now() - lastSyncAt) / 1000))
    : null;
  const connectionLabel = previewMode
    ? '体验'
    : syncError
      ? '状态未知'
      : secondsSinceSync === null
        ? '同步中'
        : `在线 · ${secondsSinceSync} 秒前`;
  const standaloneInstallRequired = requiresStandaloneInstall();
  const selectedSession =
    orderedSessions.find(
      (session) => session.session_ref === selectedSessionRef,
    ) ?? null;

  useEffect(() => {
    if (!requestedSessionRef) return;
    const requestedSession = orderedSessions.find(
      (session) => session.session_ref === requestedSessionRef,
    );
    if (!requestedSession) return;
    setSelectedSessionRef(requestedSession.session_ref);
    setRequestedSessionRef(null);
    if (Platform.OS === 'web') {
      const history = (
        globalThis as {
          history?: { replaceState(data: unknown, unused: string, url?: string): void };
        }
      ).history;
      history?.replaceState(null, '', '/');
    }
  }, [orderedSessions, requestedSessionRef]);

  useEffect(() => {
    if (selectedSessionRef && !selectedSession) {
      setSelectedSessionRef(null);
    }
  }, [selectedSession, selectedSessionRef]);

  if (booting) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator color="#111111" />
        <Text style={styles.loadingText}>正在连接 Codexy…</Text>
      </SafeAreaView>
    );
  }

  if (!savedDevice && !previewMode) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}
        >
          <ScrollView
            contentContainerStyle={styles.setupContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.wordmark}>
              <Image
                accessibilityLabel="Codexy"
                source={require('./assets/icon.png')}
                style={styles.wordmarkGlyph}
              />
              <Text style={styles.wordmarkText}>Codexy</Text>
            </View>
            <Text style={styles.setupTitle}>把 Codex 放进口袋</Text>
            <Text style={styles.setupDescription}>
              在手机上只看需要你处理的 Codex，并继续下一轮。
            </Text>

            <View style={styles.setupPromiseCard}>
              <Text style={styles.setupPromiseEyebrow}>
                {standaloneInstallRequired
                  ? 'IPHONE · 连接前完成'
                  : '准备连接'}
              </Text>
              <Text style={styles.setupPromiseTitle}>
                {standaloneInstallRequired
                  ? '先把 Codexy 添加到主屏幕'
                  : '这台电脑已经被找到'}
              </Text>
              {standaloneInstallRequired ? (
                <Text style={styles.setupInstallSteps}>
                  1. 在 Safari 点“分享”{'\n'}
                  2. 选择“添加到主屏幕”{'\n'}
                  3. 从主屏幕的新图标重新打开 Codexy
                </Text>
              ) : (
                <Text selectable style={styles.setupPromiseUrl}>
                  {relayInput}
                </Text>
              )}
              <Text style={styles.setupPromiseBody}>
                {standaloneInstallRequired
                  ? '装好后再连接，避免重复绑定。'
                  : '连接后在电脑确认一次即可。'}
              </Text>
            </View>

            {showAdvancedRelay ? (
              <>
                <Text style={styles.fieldLabel}>手动 Relay 地址</Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  onChangeText={setRelayInput}
                  placeholder="http://192.168.1.10:8797"
                  placeholderTextColor="#9A9A9A"
                  style={styles.textInput}
                  value={relayInput}
                />
              </>
            ) : null}

            {connectionError ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {connectionError}
              </Text>
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={connecting}
              onPress={() => void connect()}
              style={[
                styles.primaryButton,
                connecting && styles.buttonDisabled,
              ]}
            >
              {connecting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  {standaloneInstallRequired
                    ? '先添加到主屏幕'
                    : '连接这台电脑'}
                </Text>
              )}
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => setShowAdvancedRelay((value) => !value)}
              style={styles.advancedButton}
            >
              <Text style={styles.advancedButtonText}>
                {showAdvancedRelay ? '收起地址' : '手动填写地址'}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={startPreview}
              style={styles.previewButton}
            >
              <Text style={styles.previewButtonText}>先看看演示</Text>
              <Text style={styles.previewButtonMeta}>不连接电脑 · 不上传数据</Text>
            </Pressable>

            <Text style={styles.setupPrivacy}>
              私有连接 · 不同步完整回复 · 非官方 Codex CLI 伴侣
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (selectedSession) {
    const pendingEvent = events.find(
      (event) =>
        event.session_ref === selectedSession.session_ref &&
        event.state === 'needs_you' &&
        !event.acknowledged_at,
    );
    return (
      <CodexSessionScreen
        key={selectedSession.session_ref}
        initialReplySummary={
          dashboardSummaries[selectedSession.session_ref]
        }
        latestCommand={
          commands.find(
            (command) =>
              command.session_ref === selectedSession.session_ref,
          ) ?? null
        }
        onAcknowledge={() => {
          if (pendingEvent) void acknowledge(pendingEvent);
        }}
        onCancelPrompt={cancelPromptCommand}
        onClose={() => props.onExit ? props.onExit() : setSelectedSessionRef(null)}
        onLoadControl={() => loadControlForSession(selectedSession)}
        runtimeRevision={lastSyncAt ?? 0}
        onLoadRuntime={() => {
          if (!savedDevice || previewMode) return Promise.resolve({ session_ref: selectedSession.session_ref, context: null, weekly: null, goal_available: false, goal: null, refreshed_at: new Date().toISOString() });
          return getSessionRuntime(savedDevice, selectedSession.session_ref);
        }}
        onUpdateGoal={(input) => {
          if (!savedDevice || previewMode) return Promise.reject(new Error('请连接真实电脑后设置 Goal。'));
          return updateSessionGoal(savedDevice, selectedSession.session_ref, input);
        }}
        onLoadReplySummary={() =>
          loadReplySummaryForSession(selectedSession)
        }
        onRunControlAction={(action) =>
          runControlForSession(selectedSession, action)
        }
        onSendPrompt={(prompt, mode) =>
          sendPromptToSession(selectedSession, prompt, mode)
        }
        onUpdateControl={(model, reasoningEffort) =>
          updateControlForSession(
            selectedSession,
            model,
            reasoningEffort,
          )
        }
        online={previewMode || (lastSyncAt !== null && !syncError && Date.now() - lastSyncAt < FRESHNESS_MS)}
        session={{ ...selectedSession, host_label: props.initialDevice?.label, storage_scope: storageScope }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={retryRefresh}
            refreshing={refreshing}
            tintColor="#111111"
          />
        }
      >
        <View style={styles.topBar}>
          <View style={styles.brandRow}>
            <Image
              accessibilityLabel="Codexy"
              source={require('./assets/icon.png')}
              style={styles.brandIcon}
            />
            <View>
              <Text style={styles.brand}>Codexy</Text>
            </View>
          </View>
          <View style={styles.connectionPill}>
            <View
              style={[
                styles.connectionDot,
                syncStatusUnknown && styles.connectionDotUnknown,
              ]}
            />
            <Text style={styles.connectionPillText}>
              {connectionLabel}
            </Text>
          </View>
        </View>

        {activeTab === 'workbench' ? (
          <>
            <Text style={styles.screenEyebrow}>现在</Text>
            <Text style={styles.screenTitle}>
              {syncStatusUnknown
                ? syncError
                  ? '当前 Codex 状态未知'
                  : '正在确认 Codex 状态'
                : primaryAttention
                  ? `先处理 ${primaryAttention.projectAlias}`
                  : '现在不用管 Codex'}
            </Text>
            <Text style={styles.workbenchSummary}>
              {syncStatusUnknown
                ? lastSyncAt
                  ? `状态停留在 ${lastSuccessfulSyncLabel}，请重新同步`
                  : '还没有拿到可靠状态'
                : primaryAttention
                  ? `${attentionQueue.length} 项待处理 · ${filterCounts.running} 个运行中 · ${visibleOrderedSessions.length} 条会话`
                  : `${filterCounts.running} 个运行中 · ${visibleOrderedSessions.length} 条会话`}
            </Text>

            {!syncStatusUnknown &&
            !previewMode &&
            !paired &&
            savedDevice ? (
              <View style={styles.pairingCard}>
                <Text style={styles.pairingStep}>SETUP · 2/5</Text>
                <Text style={styles.pairingLabel}>
                  {pairingExpiry.expired || !pairingCode
                    ? '需要新的配对码'
                    : '还差一步：在电脑确认'}
                </Text>
                {!pairingExpiry.expired && pairingCode ? (
                  <>
                    <Text selectable style={styles.pairingCode}>
                      {pairingCode}
                    </Text>
                    <Text style={styles.pairingBody}>
                      在电脑的任意终端运行：
                    </Text>
                    <Text selectable style={styles.pairingCommand}>
                      codexy pair {pairingCode}
                    </Text>
                  </>
                ) : (
                  <Text style={styles.pairingBody}>
                    生成新码后，再到电脑终端完成确认。无需重新连接手机。
                  </Text>
                )}
                <Text style={styles.pairingHint}>
                  {pairingExpiry.label}；配对码只绑定这一台手机。
                </Text>
                {pairingExpiry.expired || !pairingCode ? (
                  <SpringPressable
                    accessibilityRole="button"
                    disabled={pairingRenewBusy}
                    onPress={() => void renewPairing()}
                    style={[
                      styles.pairingRenewButton,
                      pairingRenewBusy && styles.buttonDisabled,
                    ]}
                  >
                    {pairingRenewBusy ? (
                      <ActivityIndicator color="#111111" />
                    ) : (
                      <Text style={styles.pairingRenewButtonText}>
                        生成新配对码
                      </Text>
                    )}
                  </SpringPressable>
                ) : null}
              </View>
            ) : null}

            {connectionNote && !previewMode ? (
              <Text style={styles.connectionNote}>{connectionNote}</Text>
            ) : null}
            {connectionError && connectionError !== syncError ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {connectionError}
              </Text>
            ) : null}

            {syncStatusUnknown ? (
              <View
                accessibilityLiveRegion="assertive"
                style={styles.syncUnknownCard}
              >
                <Text style={styles.syncUnknownEyebrow}>
                  {syncError ? 'SYNC UNKNOWN' : 'FIRST SYNC'}
                </Text>
                <Text style={styles.syncUnknownTitle}>
                  {syncError
                    ? '暂时无法确认是否需要你'
                    : '正在获取可信状态'}
                </Text>
                <Text style={styles.syncUnknownBody}>
                  上次成功同步：{lastSuccessfulSyncLabel}。
                  {lastSyncAt
                    ? ' 下方会话仅是当时的快照，当前状态可能已经变化。'
                    : ' 在首次成功同步前，Codexy 不会显示注意力已清空。'}
                </Text>
                {syncError ? (
                  <Text accessibilityRole="alert" style={styles.syncErrorDetail}>
                    {syncError}
                  </Text>
                ) : null}
                <SpringPressable
                  accessibilityRole="button"
                  accessibilityState={{ busy: refreshing, disabled: refreshing }}
                  disabled={refreshing}
                  onPress={() => void retryRefresh()}
                  style={[
                    styles.syncRetryButton,
                    refreshing && styles.buttonDisabled,
                  ]}
                >
                  {refreshing ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.syncRetryButtonText}>重新同步</Text>
                  )}
                </SpringPressable>
              </View>
            ) : (
              <AttentionQueue
                items={attentionQueue}
                onOpen={setSelectedSessionRef}
                onSummarize={(sessionRef) =>
                  void summarizeFromWorkbench(sessionRef)
                }
                summarizingSessionRef={summarizingSessionRef}
                workingCount={filterCounts.running}
              />
            )}

            <View style={styles.sectionHeading}>
              <Text style={styles.sectionLabel}>
                {attentionQueue.length ? '其他会话' : '会话'}
              </Text>
              <Text style={styles.sectionMeta}>
                {syncStatusUnknown
                  ? lastSyncAt
                    ? `上次快照 · ${lastSuccessfulSyncLabel}`
                    : '等待可信快照'
                  : `${visibleOrderedSessions.length} 条 · 最近 24 小时`}
              </Text>
            </View>

            <View accessibilityRole="tablist" style={styles.filterRow}>
              {SESSION_FILTERS.map((filter) => {
                const selected = sessionFilter === filter.id;
                return (
                  <SpringPressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                    key={filter.id}
                    onPress={() => setSessionFilter(filter.id)}
                    pressedScale={0.97}
                    style={[
                      styles.filterButton,
                      selected && styles.filterButtonSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.filterButtonText,
                        selected && styles.filterButtonTextSelected,
                      ]}
                    >
                      {filter.label}{' '}
                      {syncStatusUnknown ? '—' : filterCounts[filter.id]}
                    </Text>
                  </SpringPressable>
                );
              })}
            </View>

            {filteredSessions.length ? (
              <View style={styles.trackList}>
                {filteredSessions.map((session, index) => (
                  <CodexSessionCard
                    index={index}
                    key={session.session_ref}
                    onHide={() => hideSessionFromWorkbench(session)}
                    onPress={() =>
                      setSelectedSessionRef(session.session_ref)
                    }
                    replySummary={dashboardSummaries[session.session_ref]}
                    session={session}
                  />
                ))}
              </View>
            ) : (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>
                  {syncStatusUnknown
                    ? '会话列表尚未确认'
                    : visibleOrderedSessions.length
                    ? '这个分组暂时是空的'
                    : hiddenSessionRefs.length
                      ? '会话轨道已整理干净'
                      : '等待第一个 Codex 会话'}
                </Text>
                <Text style={styles.emptyBody}>
                  {syncStatusUnknown
                    ? '网络恢复并同步成功后，这里才会确认当前会话轨道。'
                    : visibleOrderedSessions.length
                    ? '切换到“全部”查看其他会话。'
                    : hiddenSessionRefs.length
                      ? `已隐藏 ${hiddenSessionRefs.length} 条会话；可在“设置 → 已隐藏会话”中恢复。`
                      : '用 codexy 打开一个项目并发送 Prompt 后，这里会出现一条独立轨道。'}
                </Text>
              </View>
            )}

            {previewMode ? (
              <Pressable
                accessibilityRole="button"
                onPress={simulateNeedsYou}
                style={styles.outlineButton}
              >
                <Text style={styles.outlineButtonText}>
                  模拟一条“Codex 需要你”推送
                </Text>
              </Pressable>
            ) : null}

          </>
        ) : (
          <>
            <Text style={styles.screenEyebrow}>SETTINGS</Text>
            <Text style={styles.screenTitle}>连接与隐私</Text>
            <Text style={styles.screenLead}>
              一眼看清连接是否完整；缺哪一步，就只处理哪一步。
            </Text>

            <View style={styles.setupJourneyHeading}>
              <Text style={styles.settingsSectionLabel}>上手进度</Text>
              <Text style={styles.setupJourneyCount}>
                {syncStatusUnknown
                  ? '待重新确认'
                  : `${setupCompleteCount}/5`}
              </Text>
            </View>
            <View style={styles.setupJourney}>
              {setupChecks.map((step, index) => (
                <View key={step.label} style={styles.setupJourneyRow}>
                  <Text
                    style={[
                      styles.setupJourneyIndex,
                      step.done && styles.setupJourneyIndexDone,
                    ]}
                  >
                    {step.unknown
                      ? '?'
                      : step.done
                        ? '✓'
                        : String(index + 1).padStart(2, '0')}
                  </Text>
                  <Text
                    style={[
                      styles.setupJourneyLabel,
                      step.done && styles.setupJourneyLabelDone,
                    ]}
                  >
                    {step.label}
                    {step.unknown ? ' · 待同步确认' : ''}
                  </Text>
                </View>
              ))}
            </View>

            <Text style={styles.settingsSectionLabel}>当前连接</Text>
            <View style={styles.settingsGroup}>
              <View style={styles.settingsRow}>
                <Text style={styles.settingsLabel}>Relay</Text>
                <Text selectable style={styles.settingsValue}>
                  {previewMode
                    ? '本地体验'
                    : savedDevice?.relayUrl ?? '未连接'}
                </Text>
              </View>
              <View style={styles.settingsRow}>
                <Text style={styles.settingsLabel}>桌面配对</Text>
                <Text style={styles.settingsValue}>
                  {syncStatusUnknown
                    ? '待重新确认'
                    : previewMode
                      ? '不需要'
                      : paired
                        ? '已完成'
                        : '等待配对'}
                </Text>
              </View>
              <View style={styles.settingsRow}>
                <Text style={styles.settingsLabel}>最近同步</Text>
                <Text style={styles.settingsValue}>
                  {syncStatusUnknown
                    ? lastSyncAt
                      ? `状态未知 · 上次成功 ${lastSuccessfulSyncLabel}`
                      : '状态未知 · 尚无成功记录'
                    : connectionLabel}
                </Text>
              </View>
              <View style={styles.settingsRow}>
                <Text style={styles.settingsLabel}>手机控制</Text>
                <Text style={styles.settingsValue}>
                  {syncStatusUnknown
                    ? '待重新确认'
                    : {
                        disabled: '未启用',
                        starting: '连接中',
                        ready: '已就绪',
                        error: '异常',
                      }[remoteControl.state]}
                </Text>
              </View>
            </View>
            <Text style={styles.settingsDetail}>
              {syncStatusUnknown
                ? '当前没有可信的最新状态；重新同步前不会沿用旧结果宣称设置已完成。'
                : remoteControl.detail}
            </Text>
            {syncStatusUnknown ? (
              <SpringPressable
                accessibilityRole="button"
                disabled={refreshing}
                onPress={() => void retryRefresh()}
                style={[
                  styles.compactButton,
                  refreshing && styles.buttonDisabled,
                ]}
              >
                {refreshing ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.compactButtonText}>重新同步连接状态</Text>
                )}
              </SpringPressable>
            ) : null}

            <Text style={styles.settingsSectionLabel}>已隐藏会话</Text>
            <View style={styles.settingsCard}>
              <View style={styles.settingsCardHeading}>
                <Text style={styles.settingsCardTitle}>
                  {hiddenSessionRefs.length
                    ? `${hiddenSessionRefs.length} 条已隐藏`
                    : '工作台没有隐藏会话'}
                </Text>
                <Text style={styles.settingsCardStatus}>仅这台手机</Text>
              </View>
              <Text style={styles.settingsCardBody}>
                点击会话卡上的“隐藏”即可收起。它不会停止 Agent 或关闭通知；需要你处理或运行失败时，仍会进入注意力队列。
              </Text>
              {hiddenSessions.map((session) => (
                <SpringPressable
                  accessibilityLabel={`恢复 ${session.project_alias}`}
                  accessibilityRole="button"
                  key={session.session_ref}
                  onPress={() =>
                    void restoreHiddenSession(session.session_ref)
                  }
                  pressedScale={0.99}
                  style={styles.hiddenSessionRow}
                >
                  <View>
                    <Text style={styles.hiddenSessionName}>
                      {session.project_alias}
                    </Text>
                    <Text style={styles.hiddenSessionCode}>
                      …{session.session_ref.slice(-4).toUpperCase()}
                    </Text>
                  </View>
                  <Text style={styles.hiddenSessionRestore}>恢复</Text>
                </SpringPressable>
              ))}
              {hiddenSessionRefs.length ? (
                <SpringPressable
                  accessibilityRole="button"
                  onPress={() => void restoreHiddenSessions()}
                  style={styles.compactButton}
                >
                  <Text style={styles.compactButtonText}>恢复全部会话</Text>
                </SpringPressable>
              ) : null}
            </View>

            <Text style={styles.settingsSectionLabel}>后台通知</Text>
            <View style={styles.settingsCard}>
              <View style={styles.settingsCardHeading}>
                <Text style={styles.settingsCardTitle}>Web Push</Text>
                <Text style={styles.settingsCardStatus}>
                  {previewMode ? '体验模式' : webPushStatus.label}
                </Text>
              </View>
              <Text style={styles.settingsCardBody}>
                {previewMode
                  ? '连接私有 Relay 后，可以启用 iPhone 后台横幅。'
                  : webPushStatus.detail}
              </Text>
              {!previewMode &&
              savedDevice &&
              webPushStatus.canEnable ? (
                <SpringPressable
                  accessibilityRole="button"
                  disabled={webPushBusy}
                  onPress={() => void activateWebPush()}
                  style={[
                    styles.compactButton,
                    webPushBusy && styles.buttonDisabled,
                  ]}
                >
                  <Text style={styles.compactButtonText}>
                    {webPushBusy ? '正在启用…' : '启用后台通知'}
                  </Text>
                </SpringPressable>
              ) : null}
              {!previewMode &&
              savedDevice &&
              webPushStatus.phase === 'subscribed' ? (
                <View style={styles.notificationTestPanel}>
                  <Text style={styles.notificationTestTitle}>
                    {notificationTestConfirmed
                      ? '通知链路已验证'
                      : notificationTestSent
                        ? '测试通知已发出'
                        : '最后做一次真实测试'}
                  </Text>
                  <Text style={styles.notificationTestBody}>
                    {notificationTestConfirmed
                      ? '这台手机已经确认收到过 Codexy 的系统通知。'
                      : notificationTestSent
                        ? '锁屏或切到其他 App 检查系统横幅；看到后回这里确认。'
                        : '发送固定的安全内容，不包含 Prompt、代码或本机路径。'}
                  </Text>
                  {notificationTestSent && !notificationTestConfirmed ? (
                    <SpringPressable
                      accessibilityRole="button"
                      onPress={() => void confirmNotificationTest()}
                      style={styles.compactButton}
                    >
                      <Text style={styles.compactButtonText}>
                        我已看到测试通知
                      </Text>
                    </SpringPressable>
                  ) : null}
                  <SpringPressable
                    accessibilityRole="button"
                    disabled={notificationTestBusy}
                    onPress={() => void testNotification()}
                    style={[
                      notificationTestSent && !notificationTestConfirmed
                        ? styles.secondaryCompactButton
                        : styles.compactButton,
                      notificationTestBusy && styles.buttonDisabled,
                    ]}
                  >
                    {notificationTestBusy ? (
                      <ActivityIndicator
                        color={
                          notificationTestSent && !notificationTestConfirmed
                            ? '#111111'
                            : '#FFFFFF'
                        }
                      />
                    ) : (
                      <Text
                        style={
                          notificationTestSent && !notificationTestConfirmed
                            ? styles.secondaryCompactButtonText
                            : styles.compactButtonText
                        }
                      >
                        {notificationTestSent || notificationTestConfirmed
                          ? '再次发送测试通知'
                          : '发送测试通知'}
                      </Text>
                    )}
                  </SpringPressable>
                </View>
              ) : null}
            </View>

            <Text style={styles.settingsSectionLabel}>通知策略</Text>
            <View style={styles.notificationPreviewCard}>
              <Text style={styles.notificationPreviewApp}>CODEXY · 现在</Text>
              <Text style={styles.notificationPreviewTitle}>
                {notificationSample.title}
              </Text>
              <Text style={styles.notificationPreviewBody}>
                {notificationSample.body}
              </Text>
              <Text style={styles.notificationPreviewHint}>
                同一 CLI 的后续横幅会延续这一条，不会铺满通知中心。
              </Text>
            </View>

            <Text style={styles.preferenceLabel}>语气</Text>
            <View style={styles.preferenceOptions}>
              {NOTIFICATION_TONES.map((option) => {
                const selected =
                  notificationPreferences.notification_tone === option.id;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    disabled={notificationPreferencesBusy}
                    key={option.id}
                    onPress={() =>
                      void saveNotificationPreferences({
                        notification_tone: option.id,
                      })
                    }
                    style={[
                      styles.preferenceChip,
                      selected && styles.preferenceChipSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.preferenceChipText,
                        selected && styles.preferenceChipTextSelected,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.preferenceLabel}>什么时候叫我</Text>
            <View style={styles.notificationLevels}>
              {NOTIFICATION_LEVELS.map((option) => {
                const selected =
                  notificationPreferences.notification_level === option.id;
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    disabled={notificationPreferencesBusy}
                    key={option.id}
                    onPress={() =>
                      void saveNotificationPreferences({
                        notification_level: option.id,
                      })
                    }
                    style={[
                      styles.notificationLevel,
                      selected && styles.notificationLevelSelected,
                    ]}
                  >
                    <View style={styles.notificationLevelText}>
                      <Text
                        style={[
                          styles.notificationLevelTitle,
                          selected && styles.notificationLevelTitleSelected,
                        ]}
                      >
                        {option.label}
                      </Text>
                      <Text
                        style={[
                          styles.notificationLevelDetail,
                          selected && styles.notificationLevelDetailSelected,
                        ]}
                      >
                        {option.detail}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.notificationLevelMark,
                        selected && styles.notificationLevelMarkSelected,
                      ]}
                    >
                      {selected ? '●' : '○'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.settingsDetail}>
              默认不推“正在工作”，减少为了确认 Codex 正常而反复看手机。
            </Text>

            <Text style={styles.settingsSectionLabel}>日常使用</Text>
            <View style={styles.stepsCard}>
              <Text style={styles.step}>01 · 每个项目终端只需运行 codexy</Text>
              <Text style={styles.step}>02 · 手机先处理“需处理”，其余不用盯</Text>
              <Text style={styles.step}>03 · 用快速模板或项目简报继续 Prompt</Text>
            </View>
            <Text selectable style={styles.diagnosticCommand}>
              遇到问题：codexy doctor
            </Text>

            <Text style={styles.settingsSectionLabel}>数据边界</Text>
            <View style={styles.privacyCard}>
              <Text style={styles.privacyTitle}>推送不含 Prompt</Text>
              <Text style={styles.privacyBody}>
                推送只含项目别名、状态和短摘要。最近十条指令会先在电脑端脱敏，24
                小时后清理。
              </Text>
            </View>
            <View style={styles.privacyCard}>
              <Text style={styles.privacyTitle}>远程 Prompt 不落盘</Text>
              <Text style={styles.privacyBody}>
                你主动确认发送的原文只进入本机内存队列；送达、失败或过期后立即清除，不写入
                Relay 状态文件。
              </Text>
            </View>
            <View style={[styles.privacyCard, styles.privacyCardDark]}>
              <Text style={[styles.privacyTitle, styles.darkText]}>
                回复速览不保存完整回复
              </Text>
              <Text style={[styles.privacyBody, styles.darkMuted]}>
                只按需读取最近一次最终回复，在电脑端过滤代码块、路径、链接、邮箱和疑似
                密钥后返回 2–4 条速览；完整回复、工具日志和 transcript
                不写入 Relay，也不进入推送。
              </Text>
            </View>

            <Pressable
              accessibilityRole="button"
              disabled={connecting}
              onPress={confirmResetConnection}
              style={styles.resetButton}
            >
              <Text style={styles.resetButtonText}>
                {previewMode
                  ? '退出体验模式'
                  : connecting
                    ? '正在撤销…'
                    : '撤销并断开这台设备'}
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>

      <Modal
        animationType="fade"
        onRequestClose={() => setPendingHiddenSession(null)}
        transparent
        visible={Boolean(pendingHiddenSession)}
      >
        <View style={styles.actionOverlay}>
          <Pressable
            accessibilityLabel="取消隐藏会话"
            accessibilityRole="button"
            onPress={() => setPendingHiddenSession(null)}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.actionSheet}>
            <View style={styles.actionSheetHandle} />
            <Text style={styles.actionSheetEyebrow}>整理工作台</Text>
            <Text style={styles.actionSheetTitle}>
              隐藏 {pendingHiddenSession?.project_alias}？
            </Text>
            <Text style={styles.actionSheetBody}>
              只会从这台手机的会话轨道中隐藏，不会删除会话、停止 Agent
              或关闭通知。需要你处理或运行失败时，它仍会回到注意力队列。
            </Text>
            <SpringPressable
              accessibilityRole="button"
              onPress={() => void confirmHideSession()}
              style={styles.actionSheetPrimary}
            >
              <Text style={styles.actionSheetPrimaryText}>隐藏这条会话</Text>
            </SpringPressable>
            <SpringPressable
              accessibilityRole="button"
              onPress={() => setPendingHiddenSession(null)}
              style={styles.actionSheetCancel}
            >
              <Text style={styles.actionSheetCancelText}>取消</Text>
            </SpringPressable>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        onRequestClose={() => setResetConfirmationVisible(false)}
        transparent
        visible={resetConfirmationVisible}
      >
        <View style={styles.actionOverlay}>
          <Pressable
            accessibilityLabel="取消撤销设备"
            accessibilityRole="button"
            onPress={() => setResetConfirmationVisible(false)}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.actionSheet}>
            <View style={styles.actionSheetHandle} />
            <Text style={styles.actionSheetEyebrow}>连接管理</Text>
            <Text style={styles.actionSheetTitle}>撤销这台手机？</Text>
            <Text style={styles.actionSheetBody}>
              电脑端设备凭据、后台推送订阅和本机草稿都会删除。之后需要重新连接并配对。
            </Text>
            <SpringPressable
              accessibilityRole="button"
              disabled={connecting}
              onPress={() => {
                setResetConfirmationVisible(false);
                void resetConnection();
              }}
              style={[
                styles.actionSheetPrimary,
                styles.actionSheetDanger,
                connecting && styles.buttonDisabled,
              ]}
            >
              <Text style={styles.actionSheetPrimaryText}>
                {connecting ? '正在撤销…' : '撤销并断开'}
              </Text>
            </SpringPressable>
            <SpringPressable
              accessibilityRole="button"
              onPress={() => setResetConfirmationVisible(false)}
              style={styles.actionSheetCancel}
            >
              <Text style={styles.actionSheetCancelText}>取消</Text>
            </SpringPressable>
          </View>
        </View>
      </Modal>

      <BottomNavigation active={activeTab} onChange={setActiveTab} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { backgroundColor: '#F7F6F2', flex: 1 },
  loadingScreen: {
    alignItems: 'center',
    backgroundColor: '#F7F6F2',
    flex: 1,
    justifyContent: 'center',
  },
  loadingText: { color: '#77756F', fontSize: 11, marginTop: 12 },
  setupContent: {
    alignSelf: 'center',
    maxWidth: 620,
    paddingBottom: 44,
    paddingHorizontal: 24,
    paddingTop: 32,
    width: '100%',
  },
  wordmark: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  wordmarkGlyph: {
    borderRadius: 7,
    height: 32,
    width: 32,
  },
  wordmarkText: {
    color: '#111111',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  setupTitle: {
    color: '#111111',
    fontSize: 36,
    fontWeight: '800',
    letterSpacing: -1.3,
    lineHeight: 44,
    marginTop: 38,
  },
  setupDescription: {
    color: '#575650',
    fontSize: 15,
    lineHeight: 23,
    marginTop: 12,
  },
  setupPromiseCard: {
    backgroundColor: '#E9E7E0',
    borderColor: '#D0CDC4',
    borderWidth: 1,
    marginTop: 24,
    padding: 18,
  },
  setupPromiseEyebrow: {
    color: '#66635B',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  setupPromiseTitle: {
    color: '#20201D',
    fontSize: 17,
    fontWeight: '800',
    marginTop: 7,
  },
  setupPromiseUrl: {
    color: '#55524B',
    fontSize: 10,
    marginTop: 8,
  },
  setupInstallSteps: {
    color: '#282722',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 22,
    marginTop: 12,
  },
  setupPromiseBody: {
    color: '#57544D',
    fontSize: 12,
    lineHeight: 19,
    marginTop: 10,
  },
  fieldLabel: {
    color: '#66635B',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
    marginTop: 34,
  },
  textInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#CBC9C1',
    borderWidth: 1,
    color: '#111111',
    fontSize: 13,
    marginTop: 9,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#111111',
    marginTop: 16,
    minHeight: 52,
    justifyContent: 'center',
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  buttonDisabled: { opacity: 0.42 },
  advancedButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: 11,
  },
  advancedButtonText: {
    color: '#6E6B63',
    fontSize: 10,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  previewButton: {
    alignItems: 'center',
    borderColor: '#C9C7C0',
    borderWidth: 1,
    marginTop: 10,
    minHeight: 48,
    paddingVertical: 12,
  },
  previewButtonText: { color: '#33322E', fontSize: 12, fontWeight: '700' },
  previewButtonMeta: { color: '#69665E', fontSize: 10, marginTop: 4 },
  setupPrivacy: {
    color: '#69665E',
    fontSize: 11,
    lineHeight: 17,
    marginTop: 18,
    textAlign: 'center',
  },
  content: {
    alignSelf: 'center',
    maxWidth: 680,
    paddingBottom: 118,
    paddingHorizontal: 20,
    paddingTop: 20,
    width: '100%',
  },
  topBar: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  brandRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  brandIcon: { borderRadius: 7, height: 34, width: 34 },
  brand: {
    color: '#111111',
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.6,
  },
  connectionPill: {
    alignItems: 'center',
    borderColor: '#D2D0C8',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  connectionDot: {
    backgroundColor: '#3C8B5B',
    borderRadius: 4,
    height: 6,
    width: 6,
  },
  connectionDotError: { backgroundColor: '#B84035' },
  connectionDotUnknown: { backgroundColor: '#B17A2B' },
  connectionPillText: { color: '#58564F', fontSize: 9, fontWeight: '700' },
  screenEyebrow: {
    color: '#7B7870',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginTop: 38,
  },
  screenTitle: {
    color: '#111111',
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.9,
    lineHeight: 38,
    marginTop: 8,
  },
  screenLead: {
    color: '#5F5D56',
    fontSize: 13,
    lineHeight: 21,
    marginTop: 10,
    maxWidth: 520,
  },
  workbenchSummary: {
    color: '#646159',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 20,
    marginTop: 9,
  },
  pairingCard: {
    backgroundColor: '#111111',
    marginTop: 18,
    padding: 18,
  },
  pairingStep: {
    color: '#D96559',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  pairingLabel: {
    color: '#B7B7B7',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  pairingCode: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 6,
    marginTop: 10,
  },
  pairingBody: {
    color: '#BEBEBE',
    fontSize: 10,
    lineHeight: 17,
    marginTop: 12,
  },
  pairingCommand: {
    backgroundColor: '#292929',
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 20,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pairingHint: {
    borderTopColor: '#383838',
    borderTopWidth: 1,
    color: '#8F8F8F',
    fontSize: 9,
    lineHeight: 15,
    marginTop: 13,
    paddingTop: 11,
  },
  pairingRenewButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    marginTop: 13,
    minHeight: 44,
    paddingHorizontal: 14,
  },
  pairingRenewButtonText: {
    color: '#111111',
    fontSize: 10,
    fontWeight: '800',
  },
  connectionNote: {
    backgroundColor: '#E7E5DE',
    color: '#58564F',
    fontSize: 10,
    lineHeight: 17,
    marginTop: 16,
    padding: 11,
  },
  errorText: {
    color: '#A2322B',
    fontSize: 11,
    lineHeight: 18,
    marginTop: 12,
  },
  syncUnknownCard: {
    backgroundColor: '#F1E9DC',
    borderColor: '#D9C6A8',
    borderWidth: 1,
    marginTop: 20,
    padding: 18,
  },
  syncUnknownEyebrow: {
    color: '#8A642D',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.3,
  },
  syncUnknownTitle: {
    color: '#2D251A',
    fontSize: 17,
    fontWeight: '800',
    marginTop: 8,
  },
  syncUnknownBody: {
    color: '#6D5C45',
    fontSize: 11,
    lineHeight: 18,
    marginTop: 7,
  },
  syncErrorDetail: {
    color: '#8C3C32',
    fontSize: 9,
    lineHeight: 15,
    marginTop: 9,
  },
  syncRetryButton: {
    alignItems: 'center',
    backgroundColor: '#111111',
    marginTop: 15,
    minHeight: 44,
    paddingVertical: 12,
  },
  syncRetryButtonText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
  },
  urgentCard: {
    backgroundColor: '#111111',
    marginTop: 20,
    padding: 18,
  },
  urgentEyebrow: {
    color: '#D96559',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  urgentTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    marginTop: 9,
  },
  urgentBody: {
    color: '#C5C5C5',
    fontSize: 11,
    lineHeight: 18,
    marginTop: 8,
  },
  urgentAction: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 15,
  },
  reviewReadyCard: {
    backgroundColor: '#DDE8DE',
    borderColor: '#BCD0BF',
    borderWidth: 1,
    marginTop: 20,
    padding: 18,
  },
  reviewReadyEyebrow: {
    color: '#4E7356',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.3,
  },
  reviewReadyTitle: {
    color: '#1F3524',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 8,
  },
  reviewReadyBody: {
    color: '#526557',
    fontSize: 11,
    lineHeight: 18,
    marginTop: 7,
  },
  reviewReadyAction: {
    color: '#274B31',
    fontSize: 10,
    fontWeight: '800',
    marginTop: 14,
  },
  quietCard: {
    backgroundColor: '#EBE9E2',
    borderColor: '#D4D1C8',
    borderWidth: 1,
    marginTop: 20,
    padding: 18,
  },
  quietEyebrow: {
    color: '#77736A',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.3,
  },
  quietTitle: {
    color: '#282722',
    fontSize: 17,
    fontWeight: '800',
    marginTop: 8,
  },
  quietBody: {
    color: '#68655D',
    fontSize: 11,
    lineHeight: 18,
    marginTop: 7,
  },
  sectionHeading: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 28,
  },
  sectionLabel: {
    color: '#2A2925',
    fontSize: 14,
    fontWeight: '800',
  },
  sectionMeta: { color: '#77746C', fontSize: 11 },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12,
  },
  filterButton: {
    alignItems: 'center',
    borderColor: '#C9C6BD',
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  filterButtonSelected: { backgroundColor: '#111111', borderColor: '#111111' },
  filterButtonText: { color: '#66635B', fontSize: 9, fontWeight: '700' },
  filterButtonTextSelected: { color: '#FFFFFF' },
  trackList: { gap: 9, marginTop: 12 },
  emptyCard: {
    borderColor: '#CBC9C1',
    borderWidth: 1,
    marginTop: 12,
    padding: 18,
  },
  emptyTitle: { color: '#22211E', fontSize: 14, fontWeight: '700' },
  emptyBody: {
    color: '#6C6A63',
    fontSize: 11,
    lineHeight: 18,
    marginTop: 7,
  },
  outlineButton: {
    alignItems: 'center',
    borderColor: '#BDBAB1',
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 44,
    paddingVertical: 13,
  },
  outlineButtonText: { color: '#363530', fontSize: 11, fontWeight: '700' },
  ideaCard: {
    backgroundColor: '#EDEBE5',
    marginTop: 28,
    padding: 18,
  },
  ideaEyebrow: {
    color: '#747169',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1.4,
  },
  ideaTitle: {
    color: '#1C1B18',
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 24,
    marginTop: 9,
  },
  ideaBody: {
    color: '#5F5D56',
    fontSize: 11,
    lineHeight: 19,
    marginTop: 8,
  },
  actionOverlay: {
    backgroundColor: 'rgba(16, 16, 16, 0.34)',
    flex: 1,
    justifyContent: 'flex-end',
    padding: 12,
  },
  actionSheet: {
    alignSelf: 'center',
    backgroundColor: '#FBFAF6',
    borderColor: '#E1DED5',
    borderRadius: 26,
    borderWidth: 1,
    maxWidth: 560,
    paddingBottom: 12,
    paddingHorizontal: 18,
    paddingTop: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 0.12,
    shadowRadius: 30,
    width: '100%',
  },
  actionSheetHandle: {
    alignSelf: 'center',
    backgroundColor: '#D3D0C7',
    borderRadius: 3,
    height: 5,
    width: 42,
  },
  actionSheetEyebrow: {
    color: '#8A867E',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.3,
    marginTop: 22,
  },
  actionSheetTitle: {
    color: '#191815',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.45,
    marginTop: 7,
  },
  actionSheetBody: {
    color: '#68655E',
    fontSize: 11,
    lineHeight: 19,
    marginTop: 9,
  },
  actionSheetPrimary: {
    alignItems: 'center',
    backgroundColor: '#111111',
    borderRadius: 14,
    marginTop: 20,
    paddingVertical: 14,
  },
  actionSheetDanger: { backgroundColor: '#8E2F29' },
  actionSheetPrimaryText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  actionSheetCancel: {
    alignItems: 'center',
    borderRadius: 14,
    marginTop: 6,
    paddingVertical: 13,
  },
  actionSheetCancelText: {
    color: '#5F5C55',
    fontSize: 11,
    fontWeight: '700',
  },
  settingsSectionLabel: {
    color: '#77746C',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.3,
    marginBottom: 9,
    marginTop: 32,
  },
  setupJourneyHeading: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  setupJourneyCount: {
    color: '#77736A',
    fontSize: 10,
    fontWeight: '800',
    marginTop: 32,
  },
  setupJourney: {
    borderColor: '#D0CDC4',
    borderWidth: 1,
    paddingHorizontal: 14,
  },
  setupJourneyRow: {
    alignItems: 'center',
    borderBottomColor: '#DDDAD2',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 11,
    minHeight: 44,
  },
  setupJourneyIndex: {
    color: '#969188',
    fontSize: 9,
    fontWeight: '800',
    width: 20,
  },
  setupJourneyIndexDone: { color: '#347148' },
  setupJourneyLabel: { color: '#6B685F', fontSize: 11 },
  setupJourneyLabelDone: { color: '#292823', fontWeight: '700' },
  settingsGroup: { borderTopColor: '#D2D0C8', borderTopWidth: 1 },
  settingsRow: {
    alignItems: 'center',
    borderBottomColor: '#D2D0C8',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 49,
  },
  settingsLabel: { color: '#56544D', fontSize: 11 },
  settingsValue: {
    color: '#1E1D1A',
    flexShrink: 1,
    fontSize: 11,
    marginLeft: 18,
    textAlign: 'right',
  },
  settingsDetail: {
    color: '#85827A',
    fontSize: 9,
    lineHeight: 16,
    marginTop: 9,
  },
  settingsCard: {
    backgroundColor: '#EBE9E3',
    borderColor: '#D7D4CB',
    borderWidth: 1,
    padding: 16,
  },
  settingsCardHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  settingsCardTitle: { color: '#22211E', fontSize: 13, fontWeight: '700' },
  settingsCardStatus: { color: '#35704A', fontSize: 9, fontWeight: '700' },
  settingsCardBody: {
    color: '#65625A',
    fontSize: 10,
    lineHeight: 17,
    marginTop: 8,
  },
  hiddenSessionRow: {
    alignItems: 'center',
    borderTopColor: '#D5D2C9',
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
    minHeight: 48,
    paddingTop: 10,
  },
  hiddenSessionName: {
    color: '#2C2B27',
    fontSize: 10,
    fontWeight: '800',
  },
  hiddenSessionCode: {
    color: '#949087',
    fontSize: 8,
    letterSpacing: 0.7,
    marginTop: 4,
  },
  hiddenSessionRestore: {
    color: '#347148',
    fontSize: 9,
    fontWeight: '800',
  },
  notificationPreviewCard: {
    backgroundColor: '#111111',
    borderRadius: 16,
    padding: 16,
  },
  notificationTestPanel: {
    borderTopColor: '#D5D2C9',
    borderTopWidth: 1,
    marginTop: 14,
    paddingTop: 13,
  },
  notificationTestTitle: {
    color: '#2C2B27',
    fontSize: 11,
    fontWeight: '800',
  },
  notificationTestBody: {
    color: '#77736A',
    fontSize: 9,
    lineHeight: 15,
    marginTop: 5,
  },
  notificationPreviewApp: {
    color: '#929292',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1,
  },
  notificationPreviewTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
    marginTop: 8,
  },
  notificationPreviewBody: {
    color: '#D0D0D0',
    fontSize: 11,
    lineHeight: 17,
    marginTop: 5,
  },
  notificationPreviewHint: {
    borderTopColor: '#393939',
    borderTopWidth: 1,
    color: '#898989',
    fontSize: 9,
    lineHeight: 15,
    marginTop: 12,
    paddingTop: 10,
  },
  preferenceLabel: {
    color: '#77736A',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 16,
  },
  preferenceOptions: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
  },
  preferenceChip: {
    alignItems: 'center',
    borderColor: '#C9C6BD',
    borderWidth: 1,
    flex: 1,
    paddingVertical: 9,
  },
  preferenceChipSelected: { backgroundColor: '#111111', borderColor: '#111111' },
  preferenceChipText: { color: '#69665E', fontSize: 9, fontWeight: '700' },
  preferenceChipTextSelected: { color: '#FFFFFF' },
  notificationLevels: {
    borderColor: '#D0CDC4',
    borderWidth: 1,
    marginTop: 8,
  },
  notificationLevel: {
    alignItems: 'center',
    borderBottomColor: '#DDDAD2',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 58,
    paddingHorizontal: 13,
  },
  notificationLevelSelected: { backgroundColor: '#ECEAE3' },
  notificationLevelText: { flex: 1 },
  notificationLevelTitle: {
    color: '#4D4A43',
    fontSize: 11,
    fontWeight: '700',
  },
  notificationLevelTitleSelected: { color: '#171715' },
  notificationLevelDetail: {
    color: '#8A867D',
    fontSize: 9,
    marginTop: 4,
  },
  notificationLevelDetailSelected: { color: '#5E5A52' },
  notificationLevelMark: { color: '#A3A097', fontSize: 11, marginLeft: 12 },
  notificationLevelMarkSelected: { color: '#111111' },
  compactButton: {
    alignItems: 'center',
    backgroundColor: '#111111',
    justifyContent: 'center',
    marginTop: 13,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  compactButtonText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
  secondaryCompactButton: {
    alignItems: 'center',
    borderColor: '#A9A69D',
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 9,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  secondaryCompactButtonText: {
    color: '#32312D',
    fontSize: 10,
    fontWeight: '700',
  },
  stepsCard: {
    borderColor: '#CDCCC4',
    borderWidth: 1,
    paddingHorizontal: 15,
  },
  step: {
    borderBottomColor: '#D9D7D0',
    borderBottomWidth: 1,
    color: '#41403B',
    fontSize: 11,
    paddingVertical: 13,
  },
  diagnosticCommand: {
    backgroundColor: '#E8E6DF',
    color: '#56534C',
    fontSize: 10,
    marginTop: 10,
    padding: 11,
  },
  privacyCard: {
    borderColor: '#D0CEC6',
    borderWidth: 1,
    marginBottom: 8,
    padding: 15,
  },
  privacyCardDark: { backgroundColor: '#111111', borderColor: '#111111' },
  privacyTitle: { color: '#292824', fontSize: 12, fontWeight: '700' },
  privacyBody: {
    color: '#69665E',
    fontSize: 10,
    lineHeight: 17,
    marginTop: 6,
  },
  darkText: { color: '#FFFFFF' },
  darkMuted: { color: '#BDBDBD' },
  resetButton: {
    alignItems: 'center',
    borderColor: '#B8B5AC',
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 26,
    minHeight: 44,
    paddingVertical: 13,
  },
  resetButtonText: { color: '#4D4B44', fontSize: 11, fontWeight: '700' },
  bottomNavigation: {
    backgroundColor: '#F7F6F2',
    borderTopColor: '#CFCDC5',
    borderTopWidth: 1,
    bottom: 0,
    flexDirection: 'row',
    left: 0,
    paddingBottom: Platform.OS === 'ios' ? 18 : 8,
    paddingTop: 8,
    position: 'absolute',
    right: 0,
  },
  bottomTab: {
    alignItems: 'center',
    flex: 1,
    gap: 3,
    justifyContent: 'center',
    minHeight: 48,
    paddingVertical: 5,
  },
  bottomTabDot: { color: '#9B9890', fontSize: 8 },
  bottomTabText: { color: '#77746C', fontSize: 10, fontWeight: '600' },
  bottomTabTextActive: { color: '#111111', fontWeight: '800' },
});

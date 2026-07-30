import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
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

import { CodexSessionCard } from './src/components/CodexSessionCard';
import { CodexSessionScreen } from './src/components/CodexSessionScreen';
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
  getDeviceStatus,
  getEvents,
  getRemotePromptCommands,
  getSessionControl,
  getSessionReplySummary,
  normalizeRelayUrl,
  registerDevice,
  runSessionControlAction,
  sendRemotePrompt,
  updateDevicePreferences,
  updateSessionControl,
} from './src/relay';
import {
  clearAllCodexyStorage,
  loadSavedDevice,
  saveDevice,
} from './src/storage';
import {
  DEFAULT_WEB_PUSH_STATUS,
  disableWebPush,
  enableWebPush,
  getWebPushStatus,
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

const SESSION_FILTERS: Array<{
  id: SessionFilter;
  label: string;
}> = [
  { id: 'all', label: '全部' },
  { id: 'attention', label: '需处理' },
  { id: 'running', label: '运行中' },
  { id: 'review', label: '待复核' },
];

const POLL_INTERVAL_MS = 2_500;

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

function Metric(props: { label: string; value: string; urgent?: boolean }) {
  return (
    <View style={[styles.metric, props.urgent && styles.metricUrgent]}>
      <Text
        style={[
          styles.metricValue,
          props.urgent && styles.metricTextUrgent,
        ]}
      >
        {props.value}
      </Text>
      <Text
        style={[
          styles.metricLabel,
          props.urgent && styles.metricTextUrgent,
        ]}
      >
        {props.label}
      </Text>
    </View>
  );
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
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            key={id}
            onPress={() => props.onChange(id)}
            style={styles.bottomTab}
          >
            <Text
              style={[
                styles.bottomTabDot,
                active && styles.bottomTabTextActive,
              ]}
            >
              {active ? '●' : '○'}
            </Text>
            <Text
              style={[
                styles.bottomTabText,
                active && styles.bottomTabTextActive,
              ]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [activeTab, setActiveTab] = useState<MainTab>('workbench');
  const [savedDevice, setSavedDevice] = useState<SavedDevice | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [relayInput, setRelayInput] = useState(inferDefaultRelayUrl());
  const [showAdvancedRelay, setShowAdvancedRelay] = useState(false);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');
  const [connecting, setConnecting] = useState(false);
  const [paired, setPaired] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionNote, setConnectionNote] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [commands, setCommands] = useState<RemotePromptCommand[]>([]);
  const [selectedSessionRef, setSelectedSessionRef] = useState<string | null>(
    null,
  );
  const [requestedSessionRef, setRequestedSessionRef] = useState<string | null>(
    requestedSessionFromUrl,
  );
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const previewControlsRef = useRef(
    new Map<string, CodexControlSnapshot>(),
  );
  const [refreshing, setRefreshing] = useState(false);
  const [webPushStatus, setWebPushStatus] = useState<WebPushStatus>(
    DEFAULT_WEB_PUSH_STATUS,
  );
  const [webPushBusy, setWebPushBusy] = useState(false);
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
    void loadSavedDevice()
      .then((device) => {
        setSavedDevice(device);
        setRelayInput(device?.relayUrl ?? inferDefaultRelayUrl());
      })
      .finally(() => setBooting(false));
  }, []);

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
      if (active) setWebPushStatus(status);
    });
    return () => {
      active = false;
    };
  }, [booting, savedDevice]);

  const refresh = useCallback(async () => {
    if (!savedDevice) return;
    try {
      const [eventResult, status, sessionResult, commandResult] =
        await Promise.all([
          getEvents(
            savedDevice.relayUrl,
            savedDevice.deviceId,
            savedDevice.deviceSecret,
            cursorRef.current,
          ),
          getDeviceStatus(
            savedDevice.relayUrl,
            savedDevice.deviceId,
            savedDevice.deviceSecret,
          ),
          getAgentSessions(
            savedDevice.relayUrl,
            savedDevice.deviceId,
            savedDevice.deviceSecret,
          ),
          getRemotePromptCommands(
            savedDevice.relayUrl,
            savedDevice.deviceId,
            savedDevice.deviceSecret,
          ),
        ]);

      if (eventResult.events.length) {
        setEvents((current) => {
          const byId = new Map(current.map((event) => [event.event_id, event]));
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
      setConnectionError(null);
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : 'Codex 状态同步失败。',
      );
    }
  }, [savedDevice]);

  useEffect(() => {
    if (!savedDevice) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh, savedDevice]);

  const connect = useCallback(async () => {
    const relayUrl = normalizeRelayUrl(relayInput);
    if (!relayUrl) {
      setConnectionError('请输入 Codexy Relay 地址。');
      return;
    }
    setConnecting(true);
    setConnectionError(null);
    try {
      const push = await registerForPushNotifications();
      const deviceId = savedDevice?.deviceId ?? createDeviceId();
      const registration = await registerDevice({
        relayUrl,
        deviceId,
        deviceSecret: savedDevice?.deviceSecret,
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
      setConnectionNote(push.message);
      setSessions([]);
      setEvents([]);
      setCommands([]);
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
      await disableWebPush();
      setConnecting(false);
    }
    await clearAllCodexyStorage();
    setSavedDevice(null);
    setPreviewMode(false);
    setPaired(false);
    setPairingCode(null);
    setEvents([]);
    setSessions([]);
    setCommands([]);
    setConnectionError(null);
    setConnectionNote('');
    setLastSyncAt(null);
    setNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
    setSelectedSessionRef(null);
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
    Alert.alert(
      '撤销这台手机？',
      '电脑端设备凭据、后台推送订阅和本机草稿都会删除。之后需要重新配对。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '撤销并断开',
          style: 'destructive',
          onPress: () => void resetConnection(),
        },
      ],
    );
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
    const status = await enableWebPush({
      relayUrl: savedDevice.relayUrl,
      deviceId: savedDevice.deviceId,
      deviceSecret: savedDevice.deviceSecret,
    });
    setWebPushStatus(status);
    setConnectionNote(status.detail);
    setWebPushBusy(false);
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
      const command = await sendRemotePrompt({
        relayUrl: savedDevice.relayUrl,
        deviceId: savedDevice.deviceId,
        deviceSecret: savedDevice.deviceSecret,
        sessionRef: session.session_ref,
        prompt,
        mode,
        idempotencyKey: createCommandKey(),
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
      if (previewMode) return previewReplySummary(session);
      if (!savedDevice) throw new RelayError('尚未连接 Codexy Relay。');
      return getSessionReplySummary({
        relayUrl: savedDevice.relayUrl,
        deviceId: savedDevice.deviceId,
        deviceSecret: savedDevice.deviceSecret,
        sessionRef: session.session_ref,
      });
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
        control_status: 'observe_only',
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
    previewControlsRef.current.set(
      previewSessions[0].session_ref,
      previewControlSnapshot(previewSessions[0]),
    );
    setPreviewMode(true);
    setPaired(true);
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
    setNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
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

  const orderedSessions = useMemo(
    () =>
      [...sessions].sort((left, right) => {
        const leftUrgent = left.state === 'needs_you' ? 1 : 0;
        const rightUrgent = right.state === 'needs_you' ? 1 : 0;
        if (leftUrgent !== rightUrgent) return rightUrgent - leftUrgent;
        return (
          new Date(right.updated_at).getTime() -
          new Date(left.updated_at).getTime()
        );
      }),
    [sessions],
  );
  const urgentSession =
    orderedSessions.find((session) => session.state === 'needs_you') ?? null;
  const urgentCount = orderedSessions.filter(
    (session) =>
      session.state === 'needs_you',
  ).length;
  const controllableCount = orderedSessions.filter(
    (session) => session.control_status === 'ready',
  ).length;
  const reviewSession =
    orderedSessions.find((session) =>
      ['turn_finished', 'subtask_completed', 'completed', 'failed'].includes(
        session.state,
      ),
    ) ?? null;
  const filteredSessions = useMemo(
    () =>
      orderedSessions.filter((session) => {
        if (sessionFilter === 'attention') {
          return session.state === 'needs_you';
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
    [orderedSessions, sessionFilter],
  );
  const filterCounts: Record<SessionFilter, number> = {
    all: orderedSessions.length,
    attention: urgentCount,
    running: orderedSessions.filter((session) => session.state === 'working')
      .length,
    review: orderedSessions.filter((session) =>
      ['turn_finished', 'subtask_completed', 'completed', 'failed'].includes(
        session.state,
      ),
    ).length,
  };
  const setupChecks = [
    {
      done: Boolean(savedDevice) || previewMode,
      label: '手机已连接 Relay',
    },
    { done: paired || previewMode, label: '桌面已完成配对' },
    {
      done: previewMode || webPushStatus.phase === 'subscribed',
      label: '后台通知已启用',
    },
    {
      done: previewMode || remoteControl.state === 'ready',
      label: '手机 Prompt 已就绪',
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
    : connectionError
      ? '离线'
      : secondsSinceSync === null
        ? '连接中'
        : `在线 · ${secondsSinceSync} 秒前`;
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
              一个专为并行 Codex CLI 设计的手机工作台：先分清哪条线需要你，再继续输入。
            </Text>

            <View style={styles.featureList}>
              <Text style={styles.featureItem}>01 · 多个 CLI 一眼分清轻重缓急</Text>
              <Text style={styles.featureItem}>02 · Queue 默认安全，Steer 只用于纠偏</Text>
              <Text style={styles.featureItem}>03 · 最近 10 条脱敏 Prompt 恢复上下文</Text>
              <Text style={styles.featureItem}>04 · 本地整理目标、约束、决定与未决问题</Text>
            </View>

            <View style={styles.setupPromiseCard}>
              <Text style={styles.setupPromiseEyebrow}>FIRST RUN · 约 2 分钟</Text>
              <Text style={styles.setupPromiseTitle}>这台电脑已经被找到</Text>
              <Text selectable style={styles.setupPromiseUrl}>
                {relayInput}
              </Text>
              <Text style={styles.setupPromiseBody}>
                连接后只需在电脑确认一次配对，再在手机启用通知。
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
                <Text style={styles.primaryButtonText}>一键连接这台电脑</Text>
              )}
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => setShowAdvancedRelay((value) => !value)}
              style={styles.advancedButton}
            >
              <Text style={styles.advancedButtonText}>
                {showAdvancedRelay ? '收起高级设置' : '地址不对？手动填写 Relay'}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={startPreview}
              style={styles.previewButton}
            >
              <Text style={styles.previewButtonText}>先用演示数据体验</Text>
              <Text style={styles.previewButtonMeta}>不连接电脑 · 不上传数据</Text>
            </Pressable>

            <Text style={styles.setupPrivacy}>
              Codexy 只按需读取最近一次最终回复，并先在电脑端过滤敏感内容；
              完整回复、代码和工具日志不会进入推送或持久状态。Codexy 是非官方
              Codex CLI 伴侣。
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
        onClose={() => setSelectedSessionRef(null)}
        onLoadControl={() => loadControlForSession(selectedSession)}
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
        online={previewMode || !connectionError}
        session={selectedSession}
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
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
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
              <Text style={styles.tagline}>CODEX, WHEREVER YOU ARE</Text>
            </View>
          </View>
          <View style={styles.connectionPill}>
            <View
              style={[
                styles.connectionDot,
                connectionError && styles.connectionDotError,
              ]}
            />
            <Text style={styles.connectionPillText}>
              {connectionLabel}
            </Text>
          </View>
        </View>

        {activeTab === 'workbench' ? (
          <>
            <Text style={styles.screenEyebrow}>CODEX WORKBENCH</Text>
            <Text style={styles.screenTitle}>
              {urgentCount
                ? `现在只需要处理 ${urgentCount} 件事`
                : '现在没有事情需要你'}
            </Text>
            <Text style={styles.screenLead}>
              {urgentCount
                ? `${filterCounts.running} 个 Codex 仍在工作。先处理等待你的，再给已结束的会话接下一棒。`
                : `${filterCounts.running} 个 Codex 仍在工作。可以先放下手机；需要决定时 Codexy 会叫你。`}
            </Text>

            <View style={styles.metrics}>
              <Metric label="会话" value={String(orderedSessions.length)} />
              <Metric
                label="手机可控"
                value={String(controllableCount)}
              />
              <Metric
                label="需要你"
                urgent={Boolean(urgentSession)}
                value={String(urgentCount)}
              />
            </View>

            {!previewMode && !paired && pairingCode ? (
              <View style={styles.pairingCard}>
                <Text style={styles.pairingStep}>SETUP · 2/4</Text>
                <Text style={styles.pairingLabel}>还差一步：在电脑确认</Text>
                <Text selectable style={styles.pairingCode}>
                  {pairingCode}
                </Text>
                <Text style={styles.pairingBody}>
                  在 Codexy 工程运行下面这一条：{'\n'}
                  npm.cmd run relay:claim --{' '}
                  {pairingCode}
                </Text>
                <Text style={styles.pairingHint}>
                  配对码 10 分钟后失效；它只绑定这一台手机。
                </Text>
              </View>
            ) : null}

            {connectionNote ? (
              <Text style={styles.connectionNote}>{connectionNote}</Text>
            ) : null}
            {connectionError ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {connectionError}
              </Text>
            ) : null}

            {urgentSession ? (
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  setSelectedSessionRef(urgentSession.session_ref)
                }
                style={styles.urgentCard}
              >
                <Text style={styles.urgentEyebrow}>CODEX NEEDS YOU</Text>
                <Text style={styles.urgentTitle}>
                  {urgentSession.project_alias}
                </Text>
                <Text style={styles.urgentBody}>{urgentSession.summary}</Text>
                <Text style={styles.urgentAction}>现在处理 →</Text>
              </Pressable>
            ) : reviewSession ? (
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  setSelectedSessionRef(reviewSession.session_ref)
                }
                style={styles.reviewReadyCard}
              >
                <Text style={styles.reviewReadyEyebrow}>NEXT BEST ACTION</Text>
                <Text style={styles.reviewReadyTitle}>
                  {reviewSession.project_alias} 有结果可复核
                </Text>
                <Text style={styles.reviewReadyBody}>
                  {reviewSession.summary}
                </Text>
                <Text style={styles.reviewReadyAction}>打开本轮结果 →</Text>
              </Pressable>
            ) : orderedSessions.some((session) => session.state === 'working') ? (
              <View style={styles.quietCard}>
                <Text style={styles.quietEyebrow}>ALL CLEAR</Text>
                <Text style={styles.quietTitle}>现在没有事情需要你</Text>
                <Text style={styles.quietBody}>
                  Codex 正在工作。可以先放下手机；需要决定时 Codexy 会叫你。
                </Text>
              </View>
            ) : null}

            <View style={styles.sectionHeading}>
              <Text style={styles.sectionLabel}>会话轨道</Text>
              <Text style={styles.sectionMeta}>最近 24 小时</Text>
            </View>

            <View accessibilityRole="tablist" style={styles.filterRow}>
              {SESSION_FILTERS.map((filter) => {
                const selected = sessionFilter === filter.id;
                return (
                  <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                    key={filter.id}
                    onPress={() => setSessionFilter(filter.id)}
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
                      {filter.label} {filterCounts[filter.id]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {filteredSessions.length ? (
              <View style={styles.trackList}>
                {filteredSessions.map((session, index) => (
                  <CodexSessionCard
                    index={index}
                    key={session.session_ref}
                    onPress={() =>
                      setSelectedSessionRef(session.session_ref)
                    }
                    session={session}
                  />
                ))}
              </View>
            ) : (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>
                  {orderedSessions.length
                    ? '这个分组暂时是空的'
                    : '等待第一个 Codex 会话'}
                </Text>
                <Text style={styles.emptyBody}>
                  {orderedSessions.length
                    ? '切换到“全部”查看其他会话。'
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

            <View style={styles.ideaCard}>
              <Text style={styles.ideaEyebrow}>PROMPT → INTENT</Text>
              <Text style={styles.ideaTitle}>不是保存聊天，而是保存方向</Text>
              <Text style={styles.ideaBody}>
                每条轨道只保留最近十条脱敏用户指令，用来整理当前目标、关键约束、已做决定、未决问题和建议的下一条
                Prompt；完整回复和代码不进入这条通道。
              </Text>
            </View>
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
                {setupCompleteCount}/4
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
                    {step.done ? '✓' : String(index + 1).padStart(2, '0')}
                  </Text>
                  <Text
                    style={[
                      styles.setupJourneyLabel,
                      step.done && styles.setupJourneyLabelDone,
                    ]}
                  >
                    {step.label}
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
                  {previewMode ? '不需要' : paired ? '已完成' : '等待配对'}
                </Text>
              </View>
              <View style={styles.settingsRow}>
                <Text style={styles.settingsLabel}>最近同步</Text>
                <Text style={styles.settingsValue}>{connectionLabel}</Text>
              </View>
              <View style={styles.settingsRow}>
                <Text style={styles.settingsLabel}>手机控制</Text>
                <Text style={styles.settingsValue}>
                  {
                    {
                      disabled: '未启用',
                      starting: '连接中',
                      ready: '已就绪',
                      error: '异常',
                    }[remoteControl.state]
                  }
                </Text>
              </View>
            </View>
            <Text style={styles.settingsDetail}>{remoteControl.detail}</Text>

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
                <Pressable
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
                </Pressable>
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
              遇到问题：npm.cmd run diagnose
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
    paddingBottom: 64,
    paddingHorizontal: 24,
    paddingTop: 44,
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
    fontSize: 38,
    fontWeight: '800',
    letterSpacing: -1.3,
    lineHeight: 47,
    marginTop: 56,
  },
  setupDescription: {
    color: '#575650',
    fontSize: 15,
    lineHeight: 25,
    marginTop: 16,
  },
  featureList: {
    borderBottomColor: '#D7D5CE',
    borderTopColor: '#D7D5CE',
    borderTopWidth: 1,
    marginTop: 32,
  },
  featureItem: {
    borderBottomColor: '#D7D5CE',
    borderBottomWidth: 1,
    color: '#3F3E39',
    fontSize: 12,
    paddingVertical: 13,
  },
  setupPromiseCard: {
    backgroundColor: '#E9E7E0',
    borderColor: '#D0CDC4',
    borderWidth: 1,
    marginTop: 28,
    padding: 16,
  },
  setupPromiseEyebrow: {
    color: '#77736A',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  setupPromiseTitle: {
    color: '#20201D',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 8,
  },
  setupPromiseUrl: {
    color: '#55524B',
    fontSize: 10,
    marginTop: 8,
  },
  setupPromiseBody: {
    color: '#6A675F',
    fontSize: 10,
    lineHeight: 17,
    marginTop: 8,
  },
  fieldLabel: {
    color: '#77746C',
    fontSize: 9,
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
    marginTop: 14,
    minHeight: 49,
    justifyContent: 'center',
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  buttonDisabled: { opacity: 0.42 },
  advancedButton: {
    alignItems: 'center',
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
    paddingVertical: 12,
  },
  previewButtonText: { color: '#33322E', fontSize: 12, fontWeight: '700' },
  previewButtonMeta: { color: '#89867E', fontSize: 9, marginTop: 4 },
  setupPrivacy: {
    color: '#8B8880',
    fontSize: 9,
    lineHeight: 16,
    marginTop: 22,
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
  tagline: {
    color: '#838078',
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: 1.45,
    marginTop: 3,
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
  connectionPillText: { color: '#58564F', fontSize: 9, fontWeight: '700' },
  screenEyebrow: {
    color: '#7B7870',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.6,
    marginTop: 48,
  },
  screenTitle: {
    color: '#111111',
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.9,
    lineHeight: 38,
    marginTop: 9,
  },
  screenLead: {
    color: '#5F5D56',
    fontSize: 13,
    lineHeight: 21,
    marginTop: 10,
    maxWidth: 520,
  },
  metrics: { flexDirection: 'row', gap: 8, marginTop: 25 },
  metric: {
    backgroundColor: '#ECEAE4',
    flex: 1,
    minHeight: 76,
    padding: 12,
  },
  metricUrgent: { backgroundColor: '#111111' },
  metricValue: {
    color: '#171717',
    fontSize: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  metricLabel: { color: '#77746C', fontSize: 9, marginTop: 7 },
  metricTextUrgent: { color: '#FFFFFF' },
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
  pairingHint: {
    borderTopColor: '#383838',
    borderTopWidth: 1,
    color: '#8F8F8F',
    fontSize: 9,
    lineHeight: 15,
    marginTop: 13,
    paddingTop: 11,
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
    marginTop: 34,
  },
  sectionLabel: {
    color: '#2A2925',
    fontSize: 12,
    fontWeight: '800',
  },
  sectionMeta: { color: '#8A877F', fontSize: 9 },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12,
  },
  filterButton: {
    borderColor: '#C9C6BD',
    borderWidth: 1,
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
    marginTop: 12,
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
  notificationPreviewCard: {
    backgroundColor: '#111111',
    borderRadius: 16,
    padding: 16,
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
    marginTop: 13,
    paddingVertical: 11,
  },
  compactButtonText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
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
    marginTop: 26,
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
    paddingVertical: 5,
  },
  bottomTabDot: { color: '#9B9890', fontSize: 8 },
  bottomTabText: { color: '#77746C', fontSize: 10, fontWeight: '600' },
  bottomTabTextActive: { color: '#111111', fontWeight: '800' },
});

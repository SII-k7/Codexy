import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type {
  AgentSession,
  CodexControlAction,
  CodexControlActionResult,
  CodexControlSnapshot,
} from '../types';

const EFFORT_COPY: Record<
  string,
  { label: string; detail: string }
> = {
  none: { label: '关闭', detail: '不额外推理' },
  minimal: { label: '最小', detail: '最快响应' },
  low: { label: '轻快', detail: '低延迟推进' },
  medium: { label: '平衡', detail: '日常编码' },
  high: { label: '深入', detail: '复杂任务' },
  xhigh: { label: '极深', detail: '高难推理' },
  max: { label: '最大', detail: '更长思考' },
  ultra: { label: '多代理', detail: '最高强度' },
};

const ACTIONS: Array<{
  id: CodexControlAction;
  command: string;
  label: string;
  detail: string;
  confirm: string;
  danger?: boolean;
}> = [
  {
    id: 'status',
    command: '/status',
    label: '实时状态',
    detail: '刷新模型、权限和额度',
    confirm: '',
  },
  {
    id: 'compact',
    command: '/compact',
    label: '压缩上下文',
    detail: '为后续回合腾出空间',
    confirm: '这会立即开始压缩当前会话的上下文。',
  },
  {
    id: 'review',
    command: '/review',
    label: '代码审查',
    detail: '检查尚未提交的改动',
    confirm: '这会在该会话中启动一次未提交改动审查。',
  },
  {
    id: 'interrupt',
    command: 'STOP',
    label: '停止回合',
    detail: '中断正在运行的工作',
    confirm: '这会停止当前正在运行的 Codex 回合。',
    danger: true,
  },
];

const CONTROL_COPY: Record<
  NonNullable<AgentSession['control_status']>,
  string
> = {
  ready: '控制通道已经就绪。',
  observe_only: '该会话目前只能观察；请先在电脑端用 codexy 恢复。',
  checking: '正在检查电脑端控制通道。',
  setup_required: '需要先在电脑端启用 Codexy 控制桥接。',
  unsupported: '这个会话来源暂不支持手机控制。',
  error: '电脑端控制桥接当前不可用。',
};

function effortCopy(effort: string | null) {
  if (!effort) return { label: '未设置', detail: '跟随模型默认值' };
  return (
    EFFORT_COPY[effort] ?? {
      label: effort.toUpperCase(),
      detail: '模型提供的强度',
    }
  );
}

function stateLabel(value: string): string {
  if (value === 'active') return 'RUNNING';
  if (value === 'idle') return 'IDLE';
  if (value === 'notLoaded') return 'SLEEP';
  return value.toUpperCase();
}

function formatReset(value: string | null): string {
  if (!value) return '未提供重置时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未提供重置时间';
  return `约 ${new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)} 重置`;
}

export function CodexControlDeck(props: {
  controlStatus: NonNullable<AgentSession['control_status']>;
  online: boolean;
  sessionRef: string;
  onLoad: () => Promise<CodexControlSnapshot>;
  onRunAction: (
    action: CodexControlAction,
  ) => Promise<CodexControlActionResult>;
  onUpdate: (
    model: string,
    reasoningEffort: string,
  ) => Promise<CodexControlSnapshot>;
}) {
  const [snapshot, setSnapshot] = useState<CodexControlSnapshot | null>(
    null,
  );
  const [expanded, setExpanded] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedEffort, setSelectedEffort] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] =
    useState<CodexControlAction | null>(null);
  const [confirmSettings, setConfirmSettings] = useState(false);
  const [pendingAction, setPendingAction] =
    useState<CodexControlAction | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const pulse = useRef(new Animated.Value(0)).current;

  const adoptSnapshot = (next: CodexControlSnapshot) => {
    setSnapshot(next);
    setSelectedModel(next.model ?? next.models[0]?.id ?? '');
    const model =
      next.models.find((candidate) => candidate.id === next.model) ??
      next.models[0];
    setSelectedEffort(
      next.reasoning_effort ??
        model?.default_effort ??
        model?.supported_efforts[0] ??
        '',
    );
    setConfirmSettings(false);
  };

  useEffect(() => {
    setExpanded(false);
  }, [props.sessionRef]);

  useEffect(() => {
    if (
      props.controlStatus !== 'ready' ||
      !props.online
    ) {
      setSnapshot(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    void props
      .onLoad()
      .then((next) => {
        if (active) adoptSnapshot(next);
      })
      .catch((loadError) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : '无法读取 Codex 控制状态。',
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.controlStatus, props.online, props.sessionRef]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          duration: 1200,
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          duration: 1200,
          toValue: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const activeModel = useMemo(
    () =>
      snapshot?.models.find((model) => model.id === selectedModel) ??
      null,
    [selectedModel, snapshot],
  );
  const availableEfforts = activeModel?.supported_efforts ?? [];
  const dirty =
    Boolean(snapshot) &&
    (selectedModel !== snapshot?.model ||
      selectedEffort !== snapshot?.reasoning_effort);
  const selectedEffortCopy = effortCopy(selectedEffort);
  const primaryRate = snapshot?.rate_limit?.primary ?? null;
  const pendingActionCopy = ACTIONS.find(
    (action) => action.id === pendingAction,
  );

  const selectModel = (modelId: string) => {
    const model = snapshot?.models.find(
      (candidate) => candidate.id === modelId,
    );
    if (!model) return;
    setSelectedModel(model.id);
    if (!model.supported_efforts.includes(selectedEffort)) {
      setSelectedEffort(
        model.default_effort ?? model.supported_efforts[0] ?? '',
      );
    }
    setConfirmSettings(false);
    setNotice('');
    setError('');
  };

  const applySettings = async () => {
    if (!selectedModel || !selectedEffort) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const next = await props.onUpdate(
        selectedModel,
        selectedEffort,
      );
      adoptSnapshot(next);
      setNotice('已写入这条会话；从下一轮开始生效。');
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : '模型设置没有成功写入电脑端。',
      );
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (action: CodexControlAction) => {
    setActionBusy(action);
    setError('');
    setNotice('');
    try {
      const result = await props.onRunAction(action);
      adoptSnapshot(result.snapshot);
      setPendingAction(null);
      setNotice(result.detail);
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : '电脑端没有接受这项控制操作。',
      );
    } finally {
      setActionBusy(null);
    }
  };

  if (props.controlStatus !== 'ready') {
    return (
      <View style={[styles.deck, styles.deckUnavailable]}>
        <View style={styles.deckHeader}>
          <View>
            <Text style={styles.eyebrow}>CONTROL DECK</Text>
            <Text style={styles.deckTitle}>Codex 控制台</Text>
          </View>
          <Text style={styles.offlineBadge}>NOT READY</Text>
        </View>
        <Text style={styles.unavailableText}>
          {CONTROL_COPY[props.controlStatus]}
        </Text>
      </View>
    );
  }

  if (!props.online) {
    return (
      <View style={[styles.deck, styles.deckUnavailable]}>
        <View style={styles.deckHeader}>
          <View>
            <Text style={styles.eyebrow}>CONTROL DECK</Text>
            <Text style={styles.deckTitle}>Codex 控制台</Text>
          </View>
          <Text style={styles.offlineBadge}>OFFLINE</Text>
        </View>
        <Text style={styles.unavailableText}>
          电脑暂时不可达。控制操作不会排队，也不会显示假成功。
        </Text>
      </View>
    );
  }

  if (!expanded) {
    const modelLabel =
      snapshot?.models.find((model) => model.id === snapshot.model)
        ?.display_name ??
      snapshot?.model ??
      (loading ? '正在读取…' : '控制状态');
    const effortLabel = snapshot
      ? effortCopy(snapshot.reasoning_effort).label
      : '';
    return (
      <View style={styles.compactDeck}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded(true)}
          style={styles.compactDeckButton}
        >
          <View style={styles.compactDeckTop}>
            <View style={styles.compactTitleRow}>
              <Text style={styles.compactEyebrow}>CODEX CONTROL</Text>
              <Animated.View
                style={[
                  styles.liveDot,
                  {
                    opacity: pulse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.45, 1],
                    }),
                  },
                ]}
              />
            </View>
            <Text style={styles.compactOpen}>调整 ›</Text>
          </View>
          <View style={styles.compactDeckBottom}>
            <Text numberOfLines={1} style={styles.compactModel}>
              {modelLabel}
              {effortLabel ? ` · ${effortLabel}` : ''}
            </Text>
            <Text style={styles.compactActions}>
              /status · /review · STOP
            </Text>
          </View>
          {error ? (
            <Text numberOfLines={1} style={styles.compactError}>
              {error}
            </Text>
          ) : null}
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.deck}>
      <View style={styles.deckHeader}>
        <View>
          <Text style={styles.eyebrow}>CONTROL DECK</Text>
          <Text style={styles.deckTitle}>Codex 控制台</Text>
        </View>
        <View style={styles.deckHeaderActions}>
          <View style={styles.liveBadge}>
            <Animated.View
              style={[
                styles.liveDot,
                {
                  opacity: pulse.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.45, 1],
                  }),
                  transform: [
                    {
                      scale: pulse.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.8, 1.35],
                      }),
                    },
                  ],
                },
              ]}
            />
            <Text style={styles.liveText}>
              {snapshot ? stateLabel(snapshot.session_state) : 'LINKING'}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => setExpanded(false)}
            style={styles.collapseButton}
          >
            <Text style={styles.collapseButtonText}>收起</Text>
          </Pressable>
        </View>
      </View>

      <Text style={styles.deckIntro}>
        模型与思考强度只改变这条工作线，并从下一轮开始生效。
      </Text>

      {loading && !snapshot ? (
        <View style={styles.loadingPanel}>
          <ActivityIndicator color="#B8F34A" size="small" />
          <Text style={styles.loadingText}>正在读取电脑端能力…</Text>
        </View>
      ) : null}

      {snapshot ? (
        <>
          <View style={styles.telemetry}>
            <View style={styles.telemetryCell}>
              <Text style={styles.telemetryLabel}>MODEL</Text>
              <Text numberOfLines={1} style={styles.telemetryValue}>
                {snapshot.model ?? 'AUTO'}
              </Text>
            </View>
            <View style={styles.telemetryDivider} />
            <View style={styles.telemetryCell}>
              <Text style={styles.telemetryLabel}>EFFORT</Text>
              <Text style={styles.telemetryValue}>
                {effortCopy(snapshot.reasoning_effort).label}
              </Text>
            </View>
            <View style={styles.telemetryDivider} />
            <View style={styles.telemetryCell}>
              <Text style={styles.telemetryLabel}>ACCESS</Text>
              <Text numberOfLines={1} style={styles.telemetryValue}>
                {snapshot.permission_profile}
              </Text>
            </View>
          </View>

          <View style={styles.sectionHeading}>
            <Text style={styles.sectionIndex}>01</Text>
            <View style={styles.sectionHeadingBody}>
              <Text style={styles.sectionTitle}>选择模型</Text>
              <Text style={styles.sectionMeta}>
                来自这台电脑的实时目录
              </Text>
            </View>
          </View>
          <ScrollView
            contentContainerStyle={styles.modelRail}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {snapshot.models.map((model, index) => {
              const selected = model.id === selectedModel;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={model.id}
                  onPress={() => selectModel(model.id)}
                  style={[
                    styles.modelCard,
                    selected && styles.modelCardSelected,
                  ]}
                >
                  <View style={styles.modelCardTop}>
                    <Text
                      style={[
                        styles.modelOrdinal,
                        selected && styles.accentText,
                      ]}
                    >
                      {String(index + 1).padStart(2, '0')}
                    </Text>
                    {model.is_default ? (
                      <Text style={styles.defaultBadge}>DEFAULT</Text>
                    ) : null}
                  </View>
                  <Text
                    numberOfLines={2}
                    style={[
                      styles.modelName,
                      selected && styles.modelNameSelected,
                    ]}
                  >
                    {model.display_name}
                  </Text>
                  <Text numberOfLines={2} style={styles.modelDescription}>
                    {model.description || `${model.id} · Codex 模型`}
                  </Text>
                  <View
                    style={[
                      styles.modelSignal,
                      selected && styles.modelSignalSelected,
                    ]}
                  />
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.sectionHeading}>
            <Text style={styles.sectionIndex}>02</Text>
            <View style={styles.sectionHeadingBody}>
              <Text style={styles.sectionTitle}>思考强度</Text>
              <Text style={styles.sectionMeta}>
                {selectedEffortCopy.label} · {selectedEffortCopy.detail}
              </Text>
            </View>
          </View>
          <View style={styles.effortPanel}>
            <View style={styles.effortRail}>
              {availableEfforts.map((effort, index) => {
                const selected = effort === selectedEffort;
                return (
                  <Pressable
                    accessibilityLabel={`思考强度 ${effortCopy(effort).label}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    key={effort}
                    onPress={() => {
                      setSelectedEffort(effort);
                      setConfirmSettings(false);
                      setNotice('');
                      setError('');
                    }}
                    style={styles.effortStop}
                  >
                    <View
                      style={[
                        styles.effortNode,
                        selected && styles.effortNodeSelected,
                      ]}
                    >
                      <Text
                        style={[
                          styles.effortNodeText,
                          selected && styles.effortNodeTextSelected,
                        ]}
                      >
                        {index + 1}
                      </Text>
                    </View>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.effortLabel,
                        selected && styles.accentText,
                      ]}
                    >
                      {effortCopy(effort).label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.effortReadout}>
              <Text style={styles.effortReadoutLabel}>THINKING DEPTH</Text>
              <Text style={styles.effortReadoutValue}>
                {selectedEffort.toUpperCase()}
              </Text>
            </View>
          </View>

          {dirty ? (
            <View style={styles.pendingSettings}>
              <View style={styles.pendingSettingsCopy}>
                <Text style={styles.pendingLabel}>PENDING CHANGE</Text>
                <Text style={styles.pendingValue}>
                  {activeModel?.display_name ?? selectedModel} ·{' '}
                  {selectedEffortCopy.label}
                </Text>
              </View>
              {!confirmSettings ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setConfirmSettings(true)}
                  style={styles.applyButton}
                >
                  <Text style={styles.applyButtonText}>应用到下一轮</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {confirmSettings ? (
            <View style={styles.confirmPanel}>
              <Text style={styles.confirmTitle}>确认切换会话配置？</Text>
              <Text style={styles.confirmBody}>
                当前回合不会改变；下一轮将使用 {activeModel?.display_name}{' '}
                / {selectedEffortCopy.label}。
              </Text>
              <View style={styles.confirmActions}>
                <Pressable
                  accessibilityRole="button"
                  disabled={saving}
                  onPress={() => setConfirmSettings(false)}
                  style={styles.confirmSecondary}
                >
                  <Text style={styles.confirmSecondaryText}>返回</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={saving}
                  onPress={() => void applySettings()}
                  style={styles.confirmPrimary}
                >
                  {saving ? (
                    <ActivityIndicator color="#10120D" size="small" />
                  ) : (
                    <Text style={styles.confirmPrimaryText}>确认应用</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : null}

          <View style={styles.sectionHeading}>
            <Text style={styles.sectionIndex}>03</Text>
            <View style={styles.sectionHeadingBody}>
              <Text style={styles.sectionTitle}>快捷控制</Text>
              <Text style={styles.sectionMeta}>
                原生操作，不作为 Prompt 发送
              </Text>
            </View>
          </View>
          <View style={styles.actionGrid}>
            {ACTIONS.map((action) => {
              const enabled =
                snapshot.available_actions[action.id] &&
                actionBusy === null;
              const busy = actionBusy === action.id;
              return (
                <Pressable
                  accessibilityRole="button"
                  disabled={!enabled}
                  key={action.id}
                  onPress={() => {
                    if (action.id === 'status') {
                      void runAction('status');
                    } else {
                      setPendingAction(action.id);
                      setConfirmSettings(false);
                      setNotice('');
                      setError('');
                    }
                  }}
                  style={[
                    styles.actionButton,
                    action.danger && styles.actionButtonDanger,
                    !enabled && styles.actionButtonDisabled,
                  ]}
                >
                  <View style={styles.actionTop}>
                    <Text
                      style={[
                        styles.actionCommand,
                        action.danger && styles.actionDangerText,
                      ]}
                    >
                      {action.command}
                    </Text>
                    <Text style={styles.actionArrow}>
                      {busy ? '…' : '↗'}
                    </Text>
                  </View>
                  <Text style={styles.actionLabel}>{action.label}</Text>
                  <Text style={styles.actionDetail}>{action.detail}</Text>
                </Pressable>
              );
            })}
          </View>

          {pendingActionCopy ? (
            <View
              style={[
                styles.confirmPanel,
                pendingActionCopy.danger && styles.confirmPanelDanger,
              ]}
            >
              <Text style={styles.confirmKicker}>
                {pendingActionCopy.command}
              </Text>
              <Text style={styles.confirmTitle}>
                确认{pendingActionCopy.label}？
              </Text>
              <Text style={styles.confirmBody}>
                {pendingActionCopy.confirm}
              </Text>
              <View style={styles.confirmActions}>
                <Pressable
                  accessibilityRole="button"
                  disabled={Boolean(actionBusy)}
                  onPress={() => setPendingAction(null)}
                  style={styles.confirmSecondary}
                >
                  <Text style={styles.confirmSecondaryText}>取消</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={Boolean(actionBusy)}
                  onPress={() => void runAction(pendingActionCopy.id)}
                  style={[
                    styles.confirmPrimary,
                    pendingActionCopy.danger &&
                      styles.confirmPrimaryDanger,
                  ]}
                >
                  {actionBusy ? (
                    <ActivityIndicator color="#10120D" size="small" />
                  ) : (
                    <Text style={styles.confirmPrimaryText}>确认执行</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : null}

          {primaryRate ? (
            <View style={styles.ratePanel}>
              <View style={styles.rateHeading}>
                <Text style={styles.rateLabel}>SESSION QUOTA</Text>
                <Text style={styles.rateValue}>
                  {Math.round(primaryRate.used_percent)}% USED
                </Text>
              </View>
              <View style={styles.rateTrack}>
                <View
                  style={[
                    styles.rateUsed,
                    { flex: Math.max(primaryRate.used_percent, 0.5) },
                  ]}
                />
                <View
                  style={{
                    flex: Math.max(100 - primaryRate.used_percent, 0.5),
                  }}
                />
              </View>
              <Text style={styles.rateReset}>
                {formatReset(primaryRate.resets_at)}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}

      {notice ? (
        <Text accessibilityLiveRegion="polite" style={styles.notice}>
          ✓ {notice}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  compactDeck: {
    backgroundColor: '#11130F',
    borderColor: '#292D24',
    borderWidth: 1,
    marginTop: 11,
    overflow: 'hidden',
  },
  compactDeckButton: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  compactDeckTop: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  compactTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  compactEyebrow: {
    color: '#9DA393',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  compactOpen: {
    color: '#B8F34A',
    fontSize: 9,
    fontWeight: '800',
  },
  compactDeckBottom: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    marginTop: 8,
  },
  compactModel: {
    color: '#F0F2EC',
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
  },
  compactActions: {
    color: '#71766A',
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  compactError: {
    color: '#E6A098',
    fontSize: 8,
    marginTop: 7,
  },
  deck: {
    backgroundColor: '#11130F',
    borderColor: '#292D24',
    borderWidth: 1,
    marginTop: 11,
    overflow: 'hidden',
    paddingBottom: 18,
    paddingHorizontal: 16,
    paddingTop: 17,
  },
  deckUnavailable: {
    backgroundColor: '#1A1B18',
    minHeight: 112,
  },
  deckHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  deckHeaderActions: {
    alignItems: 'flex-end',
    gap: 6,
  },
  eyebrow: {
    color: '#92978A',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.8,
  },
  deckTitle: {
    color: '#F6F7F2',
    fontSize: 21,
    fontWeight: '700',
    marginTop: 6,
  },
  liveBadge: {
    alignItems: 'center',
    borderColor: '#41463A',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  liveDot: {
    backgroundColor: '#B8F34A',
    borderRadius: 4,
    height: 7,
    width: 7,
  },
  liveText: {
    color: '#D7F6A0',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  offlineBadge: {
    borderColor: '#4E514A',
    borderWidth: 1,
    color: '#9B9E96',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.1,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  collapseButton: {
    borderBottomColor: '#4E5347',
    borderBottomWidth: 1,
    paddingBottom: 2,
  },
  collapseButtonText: {
    color: '#91968A',
    fontSize: 8,
    fontWeight: '700',
  },
  unavailableText: {
    color: '#A8AAA3',
    fontSize: 12,
    lineHeight: 20,
    marginTop: 24,
  },
  deckIntro: {
    color: '#999E91',
    fontSize: 10,
    lineHeight: 17,
    marginTop: 12,
  },
  loadingPanel: {
    alignItems: 'center',
    borderColor: '#30342B',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
    padding: 15,
  },
  loadingText: { color: '#A9ADA2', fontSize: 11 },
  telemetry: {
    backgroundColor: '#181B15',
    borderColor: '#30352A',
    borderWidth: 1,
    flexDirection: 'row',
    marginTop: 18,
    paddingVertical: 12,
  },
  telemetryCell: {
    flex: 1,
    paddingHorizontal: 10,
  },
  telemetryDivider: {
    backgroundColor: '#33372E',
    width: 1,
  },
  telemetryLabel: {
    color: '#73796C',
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  telemetryValue: {
    color: '#E9EBE5',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 5,
  },
  sectionHeading: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 11,
    marginTop: 24,
  },
  sectionIndex: {
    color: '#B8F34A',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: 2,
  },
  sectionHeadingBody: { flex: 1 },
  sectionTitle: {
    color: '#EDEFE9',
    fontSize: 13,
    fontWeight: '700',
  },
  sectionMeta: {
    color: '#7F8478',
    fontSize: 9,
    marginTop: 4,
  },
  modelRail: {
    gap: 9,
    paddingRight: 16,
    paddingTop: 12,
  },
  modelCard: {
    backgroundColor: '#181A16',
    borderColor: '#34382F',
    borderWidth: 1,
    height: 140,
    padding: 12,
    width: 154,
  },
  modelCardSelected: {
    backgroundColor: '#20251A',
    borderColor: '#B8F34A',
  },
  modelCardTop: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modelOrdinal: {
    color: '#666C60',
    fontSize: 8,
    fontWeight: '800',
  },
  defaultBadge: {
    backgroundColor: '#2D3327',
    color: '#AEB7A3',
    fontSize: 6,
    fontWeight: '800',
    letterSpacing: 0.8,
    paddingHorizontal: 5,
    paddingVertical: 3,
  },
  modelName: {
    color: '#CED0CA',
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 20,
    marginTop: 17,
  },
  modelNameSelected: { color: '#F7F9F2' },
  modelDescription: {
    color: '#777C71',
    fontSize: 8,
    lineHeight: 12,
    marginTop: 7,
  },
  modelSignal: {
    backgroundColor: '#44493E',
    bottom: 0,
    height: 3,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  modelSignalSelected: { backgroundColor: '#B8F34A' },
  accentText: { color: '#B8F34A' },
  effortPanel: {
    backgroundColor: '#181A16',
    borderColor: '#34382F',
    borderWidth: 1,
    marginTop: 12,
    padding: 13,
  },
  effortRail: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  effortStop: {
    alignItems: 'center',
    flex: 1,
    minWidth: 38,
  },
  effortNode: {
    alignItems: 'center',
    backgroundColor: '#262A22',
    borderColor: '#42473C',
    borderRadius: 17,
    borderWidth: 1,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  effortNodeSelected: {
    backgroundColor: '#B8F34A',
    borderColor: '#B8F34A',
  },
  effortNodeText: {
    color: '#858B7E',
    fontSize: 9,
    fontWeight: '800',
  },
  effortNodeTextSelected: { color: '#11130F' },
  effortLabel: {
    color: '#777D70',
    fontSize: 7,
    fontWeight: '700',
    marginTop: 7,
    maxWidth: 48,
  },
  effortReadout: {
    alignItems: 'flex-end',
    borderTopColor: '#30342B',
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 13,
    paddingTop: 11,
  },
  effortReadoutLabel: {
    color: '#6D7267',
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  effortReadoutValue: {
    color: '#E4E7DF',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
  },
  pendingSettings: {
    alignItems: 'center',
    backgroundColor: '#20251A',
    borderColor: '#55633D',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    marginTop: 10,
    padding: 11,
  },
  pendingSettingsCopy: { flex: 1 },
  pendingLabel: {
    color: '#91AE60',
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  pendingValue: {
    color: '#ECEFE7',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 4,
  },
  applyButton: {
    backgroundColor: '#B8F34A',
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  applyButtonText: {
    color: '#11130F',
    fontSize: 9,
    fontWeight: '800',
  },
  confirmPanel: {
    backgroundColor: '#242820',
    borderColor: '#6F8052',
    borderWidth: 1,
    marginTop: 10,
    padding: 14,
  },
  confirmPanelDanger: {
    backgroundColor: '#2B1D1B',
    borderColor: '#88524C',
  },
  confirmKicker: {
    color: '#B8F34A',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  confirmTitle: {
    color: '#F1F3ED',
    fontSize: 13,
    fontWeight: '700',
  },
  confirmBody: {
    color: '#A7ABA0',
    fontSize: 10,
    lineHeight: 17,
    marginTop: 7,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 13,
  },
  confirmSecondary: {
    alignItems: 'center',
    borderColor: '#545A4C',
    borderWidth: 1,
    flex: 1,
    paddingVertical: 10,
  },
  confirmSecondaryText: {
    color: '#C0C4BA',
    fontSize: 9,
    fontWeight: '700',
  },
  confirmPrimary: {
    alignItems: 'center',
    backgroundColor: '#B8F34A',
    flex: 1.4,
    paddingVertical: 10,
  },
  confirmPrimaryDanger: { backgroundColor: '#F28B82' },
  confirmPrimaryText: {
    color: '#10120D',
    fontSize: 9,
    fontWeight: '800',
  },
  actionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  actionButton: {
    backgroundColor: '#181A16',
    borderColor: '#34382F',
    borderWidth: 1,
    minHeight: 103,
    padding: 11,
    width: '48.5%',
  },
  actionButtonDanger: { borderColor: '#523A36' },
  actionButtonDisabled: { opacity: 0.35 },
  actionTop: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  actionCommand: {
    color: '#B8F34A',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  actionDangerText: { color: '#F19A91' },
  actionArrow: { color: '#6E7468', fontSize: 10 },
  actionLabel: {
    color: '#E4E6E0',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 15,
  },
  actionDetail: {
    color: '#787D72',
    fontSize: 8,
    lineHeight: 12,
    marginTop: 4,
  },
  ratePanel: {
    borderTopColor: '#31352C',
    borderTopWidth: 1,
    marginTop: 20,
    paddingTop: 14,
  },
  rateHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rateLabel: {
    color: '#71766B',
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  rateValue: {
    color: '#9DA393',
    fontSize: 7,
    fontWeight: '800',
  },
  rateTrack: {
    backgroundColor: '#272B23',
    flexDirection: 'row',
    height: 3,
    marginTop: 9,
  },
  rateUsed: { backgroundColor: '#B8F34A' },
  rateReset: {
    color: '#656A60',
    fontSize: 7,
    marginTop: 6,
    textAlign: 'right',
  },
  notice: {
    backgroundColor: '#26301E',
    borderColor: '#4F633B',
    borderWidth: 1,
    color: '#CBEA9B',
    fontSize: 10,
    lineHeight: 16,
    marginTop: 12,
    padding: 10,
  },
  error: {
    backgroundColor: '#321F1D',
    borderColor: '#71433E',
    borderWidth: 1,
    color: '#F0B1AA',
    fontSize: 10,
    lineHeight: 16,
    marginTop: 12,
    padding: 10,
  },
});

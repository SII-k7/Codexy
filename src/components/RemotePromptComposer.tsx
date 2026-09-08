import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type {
  AgentSession,
  RemotePromptCommand,
  RemotePromptMode,
} from '../types';
import { loadPromptDraft, savePromptDraft } from '../storage';

const MAX_PROMPT_LENGTH = 4000;

type DraftSource = {
  label: string;
  text: string;
};

const COMMAND_LABELS: Record<RemotePromptCommand['status'], string> = {
  queued: '已排队',
  waiting: '排队等待发送',
  dispatching: '正在发送',
  sent: '已送达',
  failed: '发送失败',
  canceled: '已取消',
  expired: '已过期',
  unknown: '送达状态未知',
};

const CONTROL_COPY: Record<
  NonNullable<AgentSession['control_status']>,
  { label: string; body: string }
> = {
  ready: {
    label: '手机可控',
    body: '这条轨道已连接本机 App Server，可以从手机开始下一轮或插入当前回合。',
  },
  observe_only: {
    label: '仅观察',
    body: '它由普通 codex 进程打开。结束后用 codexy resume 恢复；新会话直接运行 codexy。',
  },
  checking: {
    label: '正在检查',
    body: '电脑端正在核对 App Server 与会话状态。',
  },
  setup_required: {
    label: '需要桌面桥接',
    body: '先在电脑运行一次控制安装，再用 codexy 打开 Codex。',
  },
  unsupported: {
    label: '暂不支持直发',
    body: '这个 Codex 会话当前不支持手机直发，请从电脑端重新连接。',
  },
  error: {
    label: '桥接异常',
    body: '电脑端 App Server 当前不可用，请检查 Codexy 后台服务。',
  },
};

function commandTone(status: RemotePromptCommand['status']) {
  if (status === 'sent') return styles.receiptSuccess;
  if (status === 'failed' || status === 'expired' || status === 'unknown') return styles.receiptError;
  return undefined;
}

function formatCommandTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function commandAnnouncement(command: RemotePromptCommand): string {
  const mode = command.mode === 'queue' ? '排队指令' : '当前回合补充';
  return `${mode}：${COMMAND_LABELS[command.status]}。${command.status_detail}`;
}

function queueReviewCopy(state: AgentSession['state']): string {
  if (state === 'working') {
    return '这条 Prompt 会等待当前回合结束，再作为一轮独立工作发送；不会打断正在执行的方向。';
  }
  if (state === 'needs_you') {
    return '当前回合正等你处理；这条 Prompt 会排在它之后，作为下一轮独立工作发送。';
  }
  return '当前没有正在运行的回合。这条 Prompt 将作为一轮独立工作发送，不会插入已经结束的回合。';
}

function promptSignals(prompt: string) {
  return [
    {
      id: 'goal',
      label: '目标',
      mentioned: /请|完成|实现|修复|整理|检查|分析|生成|继续|补充|添加|对比/.test(
        prompt,
      ),
    },
    {
      id: 'scope',
      label: '边界',
      mentioned: /不要|只|仅|范围|保留|避免|先|最多|至少|不改|不得/.test(
        prompt,
      ),
    },
    {
      id: 'proof',
      label: '验收',
      mentioned: /测试|验证|通过|输出|结果|完成时|给出|列出|检查/.test(
        prompt,
      ),
    },
  ];
}

export function RemotePromptComposer(props: {
  compact?: boolean;
  onSlashCommand?: (command: 'goal' | 'model', text: string) => void;
  latestCommand: RemotePromptCommand | null;
  online: boolean;
  session: AgentSession;
  suggestedPrompt?: string;
  onCancel: (commandId: string) => Promise<RemotePromptCommand>;
  onSend: (
    prompt: string,
    mode: RemotePromptMode,
  ) => Promise<RemotePromptCommand>;
}) {
  const [draft, setDraft] = useState('');
  const draftScope = `${props.session.storage_scope ? `${props.session.storage_scope}|` : ''}${props.session.session_ref}`;
  const sendInFlight = useRef(false);
  const [mode, setMode] = useState<RemotePromptMode>('queue');
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);
  const [pendingDraftSource, setPendingDraftSource] =
    useState<DraftSource | null>(null);
  const [error, setError] = useState('');
  const controlStatus = props.session.control_status ?? 'setup_required';
  const controlCopy = CONTROL_COPY[controlStatus];
  const normalizedDraft = draft.trim();
  const commandPending =
    props.latestCommand !== null &&
    ['queued', 'waiting', 'dispatching'].includes(props.latestCommand.status);
  const canSend =
    controlStatus === 'ready' &&
    props.online &&
    !commandPending &&
    draftLoaded;
  const canSteer = canSend && props.session.state === 'working';
  const characterCount = draft.length;
  const signals = useMemo(() => promptSignals(normalizedDraft), [normalizedDraft]);
  const slash = props.compact ? normalizedDraft.match(/^\/(goal|model)(?:\s+([\s\S]*))?$/) : null;
  const canReview =
    !slash &&
    canSend &&
    normalizedDraft.length > 0 &&
    (mode === 'queue' || canSteer);
  const commandStatusKey = props.latestCommand
    ? `${props.latestCommand.command_id}:${props.latestCommand.status}`
    : null;
  const commandHasError =
    props.latestCommand !== null &&
    ['failed', 'expired', 'unknown'].includes(props.latestCommand.status);
  const announcedCommandStatus = useRef(commandStatusKey);
  const announcedSessionRef = useRef(props.session.session_ref);
  const promptStarters = useMemo(
    () => [
      {
        id: 'continue',
        label: '继续推进',
        text: '沿当前目标执行下一最小步骤；完成后给出可验证结果，不扩大修改范围。',
      },
      {
        id: 'report',
        label: '先汇报',
        text: '先用三点说明已完成、当前阻塞和建议下一步；暂时不要修改文件。',
      },
      {
        id: 'verify',
        label: '只做验证',
        text: '先运行最小验证；如果失败，停下并解释原因，不自动扩大修复范围。',
      },
      {
        id: 'pause',
        label: '暂停提问',
        text: '先停止写入，列出需要我决定的 1–3 个问题。',
      },
    ],
    [],
  );

  useEffect(() => {
    let active = true;
    setPendingCommandId(null);
    setPendingDraftSource(null);
    setDraftLoaded(false);
    void loadPromptDraft(draftScope).then((savedDraft) => {
      if (!active) return;
      setDraft(savedDraft);
      setDraftLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [draftScope]);

  useEffect(() => {
    if (announcedSessionRef.current !== props.session.session_ref) {
      announcedSessionRef.current = props.session.session_ref;
      announcedCommandStatus.current = commandStatusKey;
      return;
    }
    if (!props.latestCommand || !commandStatusKey) return;
    if (announcedCommandStatus.current === commandStatusKey) return;
    announcedCommandStatus.current = commandStatusKey;
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(
        commandAnnouncement(props.latestCommand),
      );
    }
  }, [commandStatusKey, props.latestCommand, props.session.session_ref]);

  useEffect(() => {
    const command = props.latestCommand;
    if (!command || command.command_id !== pendingCommandId) return;
    if (command.status === 'sent') {
      setDraft('');
      void savePromptDraft(draftScope, '');
      setPendingCommandId(null);
      return;
    }
    if (['failed', 'canceled', 'expired', 'unknown'].includes(command.status)) {
      setPendingCommandId(null);
      setError(
        command.status === 'canceled'
          ? '指令已撤回，草稿仍保留在手机。'
          : command.status === 'unknown' ? command.status_detail
          : `${command.status_detail} 草稿仍保留在手机，可修改后重试。`,
      );
    }
  }, [pendingCommandId, props.latestCommand, draftScope]);

  useEffect(() => {
    if (!draftLoaded) return;
    const timer = setTimeout(() => {
      void savePromptDraft(draftScope, draft);
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, draftLoaded, draftScope]);

  useEffect(() => {
    if (mode === 'steer' && (!canSteer || props.compact)) setMode('queue');
  }, [canSteer, mode, props.compact]);

  const modeCopy =
    mode === 'queue'
      ? '下一轮（推荐）'
      : '补充当前回合';

  const requestDraftSource = (source: DraftSource) => {
    setError('');
    setReviewing(false);
    if (normalizedDraft) {
      setPendingDraftSource(source);
      return;
    }
    if (source.text.length > MAX_PROMPT_LENGTH) {
      setError('这条建议超过 4000 字，请先缩短后再使用。');
      return;
    }
    setDraft(source.text);
    setMode('queue');
  };

  const applyDraftSource = (action: 'append' | 'replace') => {
    if (!pendingDraftSource) return;
    const existingDraft = draft.trimEnd();
    const sourceText = pendingDraftSource.text.trimStart();
    const nextDraft =
      action === 'append'
        ? existingDraft
          ? `${existingDraft}\n\n${sourceText}`
          : sourceText
        : pendingDraftSource.text;
    if (nextDraft.length > MAX_PROMPT_LENGTH) {
      setError(
        action === 'append'
          ? '追加后会超过 4000 字；请取消并缩短现有草稿，或选择替换。'
          : '这条建议超过 4000 字，请取消并先缩短建议内容。',
      );
      return;
    }
    setDraft(nextDraft);
    setMode('queue');
    setPendingDraftSource(null);
    setError('');
  };

  const confirmSend = async () => {
    if (!canReview || sendInFlight.current) return;
    sendInFlight.current = true;
    setSending(true);
    setError('');
    try {
      const command = await props.onSend(normalizedDraft, mode);
      setPendingCommandId(command.command_id);
      setMode('queue');
      setReviewing(false);
    } catch (sendError) {
      setError(
        sendError instanceof Error
          ? sendError.message
          : '这条指令没有送达电脑端。',
      );
    } finally {
      sendInFlight.current = false;
      setSending(false);
    }
  };

  const cancelLatest = async () => {
    if (!props.latestCommand) return;
    setCanceling(true);
    setError('');
    try {
      await props.onCancel(props.latestCommand.command_id);
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : '这条待发指令没有成功撤回。',
      );
    } finally {
      setCanceling(false);
    }
  };

  if (props.compact) return <View style={simple.section}>
    <Text style={simple.title}>下一轮 Prompt</Text>
    {!props.online ? <Text style={simple.note}>电脑离线，恢复连接后可发送。草稿会保留。</Text> : controlStatus !== 'ready' ? <Text style={simple.note}>{controlCopy.body}</Text> : null}
    {props.latestCommand ? <View style={simple.receipt}><Text accessibilityLiveRegion="polite" style={[simple.note, commandHasError && simple.error]}>{COMMAND_LABELS[props.latestCommand.status]} · {props.latestCommand.status_detail}</Text>
      {['queued', 'waiting'].includes(props.latestCommand.status) ? <Pressable accessibilityRole="button" disabled={canceling || !props.online} onPress={() => void cancelLatest()} style={simple.link}><Text>{canceling ? '撤回中…' : '撤回待发指令'}</Text></Pressable> : null}
    </View> : null}
    {reviewing ? <View style={simple.review}>
      <Text style={simple.title}>确认发送到</Text>
      <Text style={simple.body}>{props.session.host_label || '电脑'} / {props.session.project_alias} / {props.session.session_ref.slice(-6)}</Text>
      <Text selectable style={simple.body}>{normalizedDraft}</Text>
      <Text style={simple.note}>{props.session.state === 'working' || props.session.state === 'needs_you' ? '当前回合结束后，作为下一轮发送。' : '作为这个会话的下一轮发送。'}</Text>
      <Pressable accessibilityRole="button" disabled={!canReview || sending} onPress={() => void confirmSend()} style={[simple.primary, (!canReview || sending) && simple.disabled]}><Text style={simple.primaryText}>{sending ? '发送中…' : '确认发送'}</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={sending} onPress={() => setReviewing(false)} style={simple.link}><Text style={simple.note}>返回修改</Text></Pressable>
    </View> : <>
      <TextInput accessibilityLabel="下一轮 Prompt" placeholder="接下来想让 Codex 做什么？" multiline maxLength={MAX_PROMPT_LENGTH} value={draft} editable={draftLoaded && !sending && !commandPending} onChangeText={(value) => { setDraft(value); setError(''); }} style={simple.input} textAlignVertical="top" />
      <Text style={simple.count}>{characterCount} / 4000</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canReview || sending }} disabled={!canReview || sending} onPress={() => { setMode('queue'); setReviewing(true); setError(''); }} style={[simple.primary, (!canReview || sending) && simple.disabled]}><Text style={simple.primaryText}>检查并发送</Text></Pressable>
    </>}
    {slash && props.onSlashCommand ? <Pressable accessibilityRole="button" onPress={() => { props.onSlashCommand?.(slash[1] as 'goal' | 'model', slash[2] ?? ''); setDraft(''); }} style={simple.link}><Text style={simple.note}>打开 /{slash[1]} 设置</Text></Pressable> : null}
    {error ? <Text accessibilityRole="alert" style={simple.error}>{error}</Text> : null}
  </View>;

  return (
    <View style={styles.section}>
      {props.session.host_label ? <Text style={styles.controlBody}>发送目标：{props.session.host_label} / {props.session.project_alias} / {props.session.session_ref.slice(-6)}</Text> : null}
      <View style={styles.heading}>
        <View style={styles.headingBody}>
          <Text style={styles.title}>继续这条工作线</Text>
        </View>
        <Text
          style={[
            styles.controlBadge,
            controlStatus === 'ready' && styles.controlBadgeReady,
          ]}
        >
          {controlCopy.label}
        </Text>
      </View>
      {controlStatus !== 'ready' ? (
        <Text style={styles.controlBody}>{controlCopy.body}</Text>
      ) : null}
      {!draftLoaded ? (
        <Text accessibilityLiveRegion="polite" style={styles.pendingNotice}>
          正在恢复这条会话保存在本机的草稿…
        </Text>
      ) : null}
      {!props.online ? (
        <Text accessibilityRole="alert" style={styles.offlineNotice}>
          电脑暂时不可达。草稿仍保存在手机；恢复连接前不会发送，也不会显示假成功。
        </Text>
      ) : null}
      {commandPending ? (
        <Text style={styles.pendingNotice}>
          当前指令送达前，草稿会继续保存在手机；确认送达后才自动清除。
        </Text>
      ) : null}

      {props.latestCommand ? (
        <View
          style={[
            styles.receipt,
            commandTone(props.latestCommand.status),
          ]}
        >
          <View style={styles.receiptHeading}>
            <Text
              accessibilityLabel={commandAnnouncement(props.latestCommand)}
              accessibilityLiveRegion={
                commandHasError ? 'assertive' : 'polite'
              }
              accessibilityRole={commandHasError ? 'alert' : undefined}
              aria-live={commandHasError ? 'assertive' : 'polite'}
              role={commandHasError ? 'alert' : 'status'}
              style={styles.receiptLabel}
            >
              {COMMAND_LABELS[props.latestCommand.status]}
            </Text>
            <Text style={styles.receiptMode}>
              {props.latestCommand.mode === 'queue' ? '排队' : '插入'}
            </Text>
          </View>
          <Text style={styles.receiptTarget}>
            目标 · {props.session.project_alias} ·{' '}
            {formatCommandTime(props.latestCommand.updated_at)}
          </Text>
          <Text style={styles.receiptDetail}>
            {props.latestCommand.status_detail}
          </Text>
          {['queued', 'waiting'].includes(props.latestCommand.status) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: canceling }}
              disabled={canceling}
              onPress={() => void cancelLatest()}
              style={styles.cancelButton}
            >
              <Text style={styles.cancelButtonText}>
                {canceling ? '正在撤回…' : '撤回待发'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {reviewing ? (
        <View style={styles.reviewCard}>
          <Text style={styles.reviewLabel}>发送前确认</Text>
          <View style={styles.reviewMeta}>
            <Text style={styles.reviewMetaText}>
              目标 · {props.session.host_label ? `${props.session.host_label} / ` : ''}{props.session.project_alias} · {props.session.session_ref.slice(-6)}
            </Text>
            <Text style={styles.reviewMetaText}>
              {mode === 'queue' ? '下一轮' : '当前回合'}
            </Text>
          </View>
          <Text selectable style={styles.reviewPrompt}>
            {normalizedDraft}
          </Text>
          <View style={styles.signalRow}>
            {signals.map((signal) => (
              <View
                key={signal.id}
                style={[
                  styles.signalPill,
                  signal.mentioned && styles.signalPillMentioned,
                ]}
              >
                <Text
                  style={[
                    styles.signalText,
                    signal.mentioned && styles.signalTextMentioned,
                  ]}
                >
                  {signal.label} ·{' '}
                  {signal.mentioned ? '可能已提到' : '可考虑补充'}
                </Text>
              </View>
            ))}
          </View>
          <Text style={styles.signalHelp}>
            仅按文字线索提示，不代表内容完整或已经满足验收。
          </Text>
          <Text style={styles.reviewWarning}>
            {mode === 'steer'
              ? '“插入当前回合”会改变正在执行的方向；请确认它确实是补充，而不是一项独立任务。'
              : queueReviewCopy(props.session.state)}
          </Text>
          {error ? (
            <Text
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              aria-live="assertive"
              role="alert"
              style={styles.error}
            >
              {error}
            </Text>
          ) : null}
          <View style={styles.reviewActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: sending }}
              disabled={sending}
              onPress={() => setReviewing(false)}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>返回修改</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{
                busy: sending,
                disabled: sending || !canReview,
              }}
              disabled={sending || !canReview}
              onPress={() => void confirmSend()}
              style={[
                styles.sendButton,
                (sending || !canReview) && styles.buttonDisabled,
              ]}
            >
              {sending ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.sendButtonText}>确认发送</Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : (
        <>
          <TextInput
            accessibilityLabel="给这个 Codex 会话输入新指令"
            editable={canSend}
            maxLength={MAX_PROMPT_LENGTH}
            multiline
            onChangeText={setDraft}
            placeholder={
              canSend
                ? '例如：保留现有实现，再补一组手机尺寸测试。'
                : '该会话准备好后可从这里发送。'
            }
            placeholderTextColor="#98968F"
            style={[
              styles.input,
              !canSend && styles.inputDisabled,
            ]}
            textAlignVertical="top"
            value={draft}
          />
          <View style={styles.inputMeta}>
            <Text style={styles.modeExplanation}>{modeCopy}</Text>
            <Text style={styles.characterCount}>{characterCount}/4000</Text>
          </View>
          <View style={styles.starterRow}>
            {promptStarters.map((starter) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSend }}
                disabled={!canSend}
                key={starter.id}
                onPress={() => requestDraftSource(starter)}
                style={[
                  styles.starterButton,
                  !canSend && styles.buttonDisabled,
                ]}
              >
                <Text style={styles.starterButtonText}>{starter.label}</Text>
              </Pressable>
            ))}
          </View>
          {props.suggestedPrompt ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={() =>
                requestDraftSource({
                  label: '思路整理建议',
                  text: props.suggestedPrompt ?? '',
                })
              }
              style={[
                styles.suggestionButton,
                !canSend && styles.buttonDisabled,
              ]}
            >
              <Text style={styles.suggestionButtonText}>
                使用任务概览建议
              </Text>
            </Pressable>
          ) : null}
          {pendingDraftSource ? (
            <View style={styles.draftChoiceCard}>
              <Text
                accessibilityLiveRegion="polite"
                aria-live="polite"
                role="status"
                style={styles.draftChoiceTitle}
              >
                草稿已有内容，如何使用“{pendingDraftSource.label}”？
              </Text>
              <Text style={styles.draftChoiceBody}>
                追加会把建议放到草稿末尾；替换会清除当前草稿。取消则不做改动。
              </Text>
              <View style={styles.draftChoiceActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => applyDraftSource('append')}
                  style={styles.draftChoicePrimaryButton}
                >
                  <Text style={styles.draftChoicePrimaryText}>追加</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => applyDraftSource('replace')}
                  style={styles.draftChoiceButton}
                >
                  <Text style={styles.draftChoiceButtonText}>替换</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setPendingDraftSource(null);
                    setError('');
                  }}
                  style={styles.draftChoiceButton}
                >
                  <Text style={styles.draftChoiceButtonText}>取消</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          <View style={styles.modeRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{
                disabled: !canSend,
                selected: mode === 'queue',
              }}
              disabled={!canSend}
              onPress={() => setMode('queue')}
              style={[
                styles.modeButton,
                mode === 'queue' && styles.modeButtonSelected,
              ]}
            >
              <Text
                style={[
                  styles.modeButtonText,
                  mode === 'queue' && styles.modeButtonTextSelected,
                ]}
              >
                排到下一轮
              </Text>
              <Text
                style={[
                  styles.modeButtonHint,
                  mode === 'queue' && styles.modeButtonHintSelected,
                ]}
              >
                推荐 · 不打断
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{
                disabled: !canSteer,
                selected: mode === 'steer',
              }}
              disabled={!canSteer}
              onPress={() => setMode('steer')}
              style={[
                styles.modeButton,
                mode === 'steer' && styles.modeButtonSelected,
                !canSteer && styles.modeButtonDisabled,
              ]}
            >
              <Text
                style={[
                  styles.modeButtonText,
                  mode === 'steer' && styles.modeButtonTextSelected,
                ]}
              >
                补充当前回合
              </Text>
              <Text
                style={[
                  styles.modeButtonHint,
                  mode === 'steer' && styles.modeButtonHintSelected,
                ]}
              >
                只用于及时纠偏
              </Text>
            </Pressable>
          </View>

          {error ? (
            <Text
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              aria-live="assertive"
              role="alert"
              style={styles.error}
            >
              {error}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{
              disabled: !canReview,
            }}
            disabled={!canReview}
            onPress={() => {
              setError('');
              setReviewing(true);
            }}
            style={[
              styles.reviewButton,
              !canReview && styles.buttonDisabled,
            ]}
          >
            <Text style={styles.reviewButtonText}>检查发送内容</Text>
          </Pressable>
        </>
      )}

      <Text style={styles.privacy}>
        经 Tailscale 私有连接发送 · 不写入 Relay 状态
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderBottomColor: '#D8D7D1',
    borderBottomWidth: 1,
    marginTop: 26,
    paddingBottom: 26,
  },
  heading: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  headingBody: { flex: 1 },
  title: {
    color: '#171717',
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 28,
  },
  controlBadge: {
    backgroundColor: '#ECEBE6',
    color: '#6E6C65',
    fontSize: 9,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  controlBadgeReady: { backgroundColor: '#DDEBDF', color: '#285E35' },
  controlBody: {
    color: '#686660',
    fontSize: 11,
    lineHeight: 18,
    marginTop: 10,
  },
  offlineNotice: {
    backgroundColor: '#F1E7E3',
    color: '#794B43',
    fontSize: 10,
    lineHeight: 17,
    marginTop: 12,
    padding: 11,
  },
  pendingNotice: {
    backgroundColor: '#EEE9DA',
    borderRadius: 12,
    color: '#625C4E',
    fontSize: 10,
    lineHeight: 15,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  receipt: {
    backgroundColor: '#F1F0EB',
    borderColor: '#DCD9D0',
    borderWidth: 1,
    marginTop: 15,
    padding: 13,
  },
  receiptSuccess: { backgroundColor: '#E6F0E7', borderColor: '#B8D0BC' },
  receiptError: { backgroundColor: '#F5E8E5', borderColor: '#DFBDB5' },
  receiptHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  receiptLabel: { color: '#33312C', fontSize: 11, fontWeight: '700' },
  receiptMode: { color: '#77736A', fontSize: 9 },
  receiptTarget: {
    color: '#77736A',
    fontSize: 9,
    marginTop: 7,
  },
  receiptDetail: {
    color: '#666158',
    fontSize: 10,
    lineHeight: 16,
    marginTop: 6,
  },
  cancelButton: {
    alignSelf: 'flex-start',
    borderColor: '#A9A59B',
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 10,
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  cancelButtonText: { color: '#504D46', fontSize: 9, fontWeight: '700' },
  starterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 12,
  },
  starterButton: {
    borderColor: '#CBC8BF',
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  starterButtonText: { color: '#45433D', fontSize: 10, fontWeight: '700' },
  suggestionButton: {
    backgroundColor: '#ECEAE3',
    borderColor: '#D2CFC5',
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 10,
    minHeight: 44,
    padding: 13,
  },
  suggestionButtonText: {
    color: '#25241F',
    fontSize: 11,
    fontWeight: '700',
  },
  draftChoiceCard: {
    backgroundColor: '#F3F0E8',
    borderColor: '#CFC9BA',
    borderWidth: 1,
    marginTop: 10,
    padding: 12,
  },
  draftChoiceTitle: {
    color: '#34312B',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 17,
  },
  draftChoiceBody: {
    color: '#716C62',
    fontSize: 9,
    lineHeight: 15,
    marginTop: 5,
  },
  draftChoiceActions: {
    flexDirection: 'row',
    gap: 7,
    marginTop: 10,
  },
  draftChoiceButton: {
    alignItems: 'center',
    borderColor: '#BDB7A9',
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 8,
  },
  draftChoicePrimaryButton: {
    alignItems: 'center',
    backgroundColor: '#25241F',
    borderColor: '#25241F',
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 8,
  },
  draftChoiceButtonText: {
    color: '#4F4B43',
    fontSize: 10,
    fontWeight: '700',
  },
  draftChoicePrimaryText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
  input: {
    borderColor: '#CFCBC0',
    borderWidth: 1,
    color: '#1D1D1A',
    fontSize: 14,
    lineHeight: 22,
    marginTop: 17,
    minHeight: 128,
    padding: 14,
  },
  inputDisabled: { backgroundColor: '#F3F2EE', color: '#8E8B84' },
  inputMeta: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginTop: 7,
  },
  modeExplanation: {
    color: '#85827A',
    flex: 1,
    fontSize: 9,
    lineHeight: 14,
  },
  characterCount: {
    color: '#8B8880',
    fontSize: 9,
    fontVariant: ['tabular-nums'],
  },
  signalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  signalPill: {
    backgroundColor: '#EEECE6',
    borderColor: '#D9D6CD',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  signalPillMentioned: {
    backgroundColor: '#E9E7E1',
    borderColor: '#C9C5BB',
  },
  signalText: { color: '#86827A', fontSize: 8, fontWeight: '700' },
  signalTextMentioned: { color: '#5D5951' },
  signalHelp: {
    color: '#918D84',
    fontSize: 8,
    lineHeight: 13,
    marginTop: 6,
  },
  modeRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  modeButton: {
    borderColor: '#CAC7BF',
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    padding: 12,
  },
  modeButtonSelected: { backgroundColor: '#111111', borderColor: '#111111' },
  modeButtonDisabled: { opacity: 0.42 },
  modeButtonText: { color: '#34332F', fontSize: 11, fontWeight: '700' },
  modeButtonTextSelected: { color: '#FFFFFF' },
  modeButtonHint: { color: '#85827C', fontSize: 8, marginTop: 5 },
  modeButtonHintSelected: { color: '#BDBDBD' },
  reviewButton: {
    alignItems: 'center',
    backgroundColor: '#111111',
    justifyContent: 'center',
    marginTop: 13,
    minHeight: 44,
    paddingVertical: 14,
  },
  reviewButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  reviewCard: {
    backgroundColor: '#F2F1EC',
    borderColor: '#D9D6CC',
    borderWidth: 1,
    marginTop: 17,
    padding: 16,
  },
  reviewLabel: {
    color: '#6F6C64',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  reviewMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  reviewMetaText: { color: '#6F6C64', fontSize: 9 },
  reviewPrompt: {
    backgroundColor: '#111111',
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 21,
    marginTop: 10,
    padding: 14,
  },
  reviewWarning: {
    color: '#7B655F',
    fontSize: 9,
    lineHeight: 15,
    marginTop: 10,
  },
  reviewActions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  secondaryButton: {
    alignItems: 'center',
    borderColor: '#BDB9AE',
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: 12,
  },
  secondaryButtonText: { color: '#44413B', fontSize: 11, fontWeight: '700' },
  sendButton: {
    alignItems: 'center',
    backgroundColor: '#111111',
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: 12,
  },
  sendButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  buttonDisabled: { opacity: 0.4 },
  error: {
    color: '#9E3029',
    fontSize: 10,
    lineHeight: 16,
    marginTop: 10,
  },
  privacy: {
    color: '#918E86',
    fontSize: 10,
    lineHeight: 16,
    marginTop: 15,
    textAlign: 'center',
  },
});

const simple = StyleSheet.create({
  section: { paddingVertical: 24, gap: 12 }, title: { fontSize: 16, fontWeight: '600', color: '#25292F' },
  input: { minHeight: 132, fontSize: 16, lineHeight: 25, padding: 14, borderWidth: 1, borderColor: '#DCE0E5', borderRadius: 10, backgroundColor: '#FFF', color: '#25292F' },
  count: { fontSize: 12, color: '#777E88', textAlign: 'right' }, primary: { minHeight: 48, borderRadius: 10, backgroundColor: '#25292F', alignItems: 'center', justifyContent: 'center', padding: 12 },
  primaryText: { color: '#FFF', fontWeight: '500', fontSize: 16 }, disabled: { opacity: 0.4 }, note: { fontSize: 13, lineHeight: 22, color: '#6B7280' },
  body: { fontSize: 16, lineHeight: 26, color: '#353B44' }, review: { gap: 14, padding: 16, backgroundColor: '#F6F7F8', borderRadius: 10 },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' }, receipt: { gap: 4 }, error: { fontSize: 14, lineHeight: 22, color: '#A34435' },
});

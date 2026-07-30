import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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

const COMMAND_LABELS: Record<RemotePromptCommand['status'], string> = {
  queued: '已排队',
  waiting: '等待当前回合',
  dispatching: '正在发送',
  sent: '已送达',
  failed: '发送失败',
  canceled: '已取消',
  expired: '已过期',
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
  if (status === 'failed' || status === 'expired') return styles.receiptError;
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

function promptSignals(prompt: string) {
  return [
    {
      id: 'goal',
      label: '目标',
      ready: /请|完成|实现|修复|整理|检查|分析|生成|继续|补充|添加|对比/.test(
        prompt,
      ),
    },
    {
      id: 'scope',
      label: '边界',
      ready: /不要|只|仅|范围|保留|避免|先|最多|至少|不改|不得/.test(
        prompt,
      ),
    },
    {
      id: 'proof',
      label: '验收',
      ready: /测试|验证|通过|输出|结果|完成时|给出|列出|检查/.test(
        prompt,
      ),
    },
  ];
}

export function RemotePromptComposer(props: {
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
  const [mode, setMode] = useState<RemotePromptMode>('queue');
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const controlStatus = props.session.control_status ?? 'setup_required';
  const controlCopy = CONTROL_COPY[controlStatus];
  const normalizedDraft = draft.trim();
  const commandPending =
    props.latestCommand !== null &&
    ['queued', 'waiting', 'dispatching'].includes(props.latestCommand.status);
  const canSend =
    controlStatus === 'ready' && props.online && !commandPending;
  const canSteer = canSend && props.session.state === 'working';
  const characterCount = draft.length;
  const signals = useMemo(() => promptSignals(normalizedDraft), [normalizedDraft]);
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
    setDraftLoaded(false);
    void loadPromptDraft(props.session.session_ref).then((savedDraft) => {
      if (!active) return;
      setDraft(savedDraft);
      setDraftLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [props.session.session_ref]);

  useEffect(() => {
    const command = props.latestCommand;
    if (!command || command.command_id !== pendingCommandId) return;
    if (command.status === 'sent') {
      setDraft('');
      void savePromptDraft(props.session.session_ref, '');
      setPendingCommandId(null);
      return;
    }
    if (['failed', 'canceled', 'expired'].includes(command.status)) {
      setPendingCommandId(null);
      setError(
        command.status === 'canceled'
          ? '指令已撤回，草稿仍保留在手机。'
          : `${command.status_detail} 草稿仍保留在手机，可修改后重试。`,
      );
    }
  }, [pendingCommandId, props.latestCommand, props.session.session_ref]);

  useEffect(() => {
    if (!draftLoaded) return;
    const timer = setTimeout(() => {
      void savePromptDraft(props.session.session_ref, draft);
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, draftLoaded, props.session.session_ref]);
  const modeCopy = useMemo(
    () =>
      mode === 'queue'
        ? '等当前回合结束，再开始一轮新的工作。'
        : '把补充要求送进正在运行的这一回合。',
    [mode],
  );

  const confirmSend = async () => {
    if (!normalizedDraft || !canSend) return;
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

  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        <View style={styles.headingBody}>
          <Text style={styles.eyebrow}>REMOTE PROMPT</Text>
          <Text style={styles.title}>从手机继续这条工作线</Text>
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
      <Text style={styles.controlBody}>{controlCopy.body}</Text>
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
            <Text style={styles.receiptLabel}>
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
              目标 · {props.session.project_alias}
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
                  signal.ready && styles.signalPillReady,
                ]}
              >
                <Text
                  style={[
                    styles.signalText,
                    signal.ready && styles.signalTextReady,
                  ]}
                >
                  {signal.ready ? '✓' : '·'} {signal.label}
                </Text>
              </View>
            ))}
          </View>
          <Text style={styles.reviewWarning}>
            {mode === 'steer'
              ? '“插入当前回合”会改变正在执行的方向；请确认它确实是补充，而不是一项独立任务。'
              : '这条 Prompt 会等待当前回合结束，再作为一轮独立工作发送；不会打断正在执行的方向。'}
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.reviewActions}>
            <Pressable
              accessibilityRole="button"
              disabled={sending}
              onPress={() => setReviewing(false)}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>返回修改</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={sending}
              onPress={() => void confirmSend()}
              style={[
                styles.sendButton,
                sending && styles.buttonDisabled,
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
          <Text style={styles.starterLabel}>快速开始</Text>
          <View style={styles.starterRow}>
            {promptStarters.map((starter) => (
              <Pressable
                accessibilityRole="button"
                disabled={!canSend}
                key={starter.id}
                onPress={() => {
                  setDraft(starter.text);
                  setMode('queue');
                  setReviewing(false);
                }}
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
              disabled={!canSend}
              onPress={() => {
                setDraft(props.suggestedPrompt ?? '');
                setMode('queue');
                setReviewing(false);
              }}
              style={[
                styles.suggestionButton,
                !canSend && styles.buttonDisabled,
              ]}
            >
              <Text style={styles.suggestionButtonLabel}>USE PROJECT BRIEF</Text>
              <Text style={styles.suggestionButtonText}>
                使用“思路整理”生成的下一条 Prompt →
              </Text>
            </Pressable>
          ) : null}
          <TextInput
            accessibilityLabel="给这个 Codex 会话输入新指令"
            editable={canSend}
            maxLength={4000}
            multiline
            onChangeText={setDraft}
            placeholder={
              canSend
                ? '例如：先保留现有实现，再补一组手机尺寸的交互测试。'
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
          <View style={styles.signalRow}>
            {signals.map((signal) => (
              <View
                key={signal.id}
                style={[
                  styles.signalPill,
                  signal.ready && styles.signalPillReady,
                ]}
              >
                <Text
                  style={[
                    styles.signalText,
                    signal.ready && styles.signalTextReady,
                  ]}
                >
                  {signal.ready ? '✓' : '·'} {signal.label}
                </Text>
              </View>
            ))}
          </View>

          <View style={styles.modeRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: mode === 'queue' }}
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
              accessibilityState={{ selected: mode === 'steer' }}
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

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            accessibilityRole="button"
            disabled={!canSend || !normalizedDraft}
            onPress={() => {
              setError('');
              setReviewing(true);
            }}
            style={[
              styles.reviewButton,
              (!canSend || !normalizedDraft) && styles.buttonDisabled,
            ]}
          >
            <Text style={styles.reviewButtonText}>检查发送内容</Text>
          </Pressable>
        </>
      )}

      <Text style={styles.privacy}>
        远程指令会以原文经过你的 Tailscale 私有 HTTPS 链路送回电脑，但不会进入推送通知，也不会写入
        Relay 状态文件；送达或失败后立即从内存队列清除。
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderBottomColor: '#D8D7D1',
    borderBottomWidth: 1,
    marginTop: 32,
    paddingBottom: 32,
  },
  heading: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  headingBody: { flex: 1 },
  eyebrow: {
    color: '#77756F',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
  },
  title: {
    color: '#171717',
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 28,
    marginTop: 6,
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
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  cancelButtonText: { color: '#504D46', fontSize: 9, fontWeight: '700' },
  starterLabel: {
    color: '#7A776F',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginTop: 18,
  },
  starterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 9,
  },
  starterButton: {
    borderColor: '#CBC8BF',
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  starterButtonText: { color: '#45433D', fontSize: 10, fontWeight: '700' },
  suggestionButton: {
    backgroundColor: '#ECEAE3',
    borderColor: '#D2CFC5',
    borderWidth: 1,
    marginTop: 10,
    padding: 13,
  },
  suggestionButtonLabel: {
    color: '#77736A',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  suggestionButtonText: {
    color: '#25241F',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 5,
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
  signalRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  signalPill: {
    backgroundColor: '#EEECE6',
    borderColor: '#D9D6CD',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  signalPillReady: { backgroundColor: '#E2EEE4', borderColor: '#BED4C2' },
  signalText: { color: '#86827A', fontSize: 8, fontWeight: '700' },
  signalTextReady: { color: '#2D6C3E' },
  modeRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  modeButton: {
    borderColor: '#CAC7BF',
    borderWidth: 1,
    flex: 1,
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
    marginTop: 13,
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
    paddingVertical: 12,
  },
  secondaryButtonText: { color: '#44413B', fontSize: 11, fontWeight: '700' },
  sendButton: {
    alignItems: 'center',
    backgroundColor: '#111111',
    flex: 1,
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
    fontSize: 8,
    lineHeight: 14,
    marginTop: 13,
  },
});

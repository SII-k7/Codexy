import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AgentSession, CodexControlSnapshot, CodexGoal, CodexGoalInput, CodexSessionRuntime } from '../types';

const goalLabels: Record<string,string> = { active: '推进中', paused: '已暂停', blocked: '有阻塞', usageLimited: '额度受限', budgetLimited: '预算已用完', complete: '已完成' };
const operationKey = () => `goal-${Date.now()}-${Math.random().toString(36).slice(2,12)}`;
export function SessionTools(props: {
  session: AgentSession; online: boolean; revision: number;
  shortcut: { command: 'goal' | 'model'; text: string; nonce: number } | null;
  onLoadRuntime: () => Promise<CodexSessionRuntime>;
  onLoadControl: () => Promise<CodexControlSnapshot>;
  onUpdateControl: (model: string, effort: string) => Promise<CodexControlSnapshot>;
  onUpdateGoal: (input: CodexGoalInput) => Promise<{ goal: CodexGoal | null }>;
}) {
  const [runtime, setRuntime] = useState<CodexSessionRuntime | null>(null);
  const [control, setControl] = useState<CodexControlSnapshot | null>(null);
  const [panel, setPanel] = useState<'goal' | 'model' | null>(null);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [objective, setObjective] = useState('');
  const [budget, setBudget] = useState('');
  const [review, setReview] = useState<CodexGoalInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [runtimeError, setRuntimeError] = useState(false);
  const inflight = useRef(false);
  const callbacks = useRef(props); callbacks.current = props;
  const usable = props.online && props.session.control_status === 'ready';
  const currentModel = control?.models.find(item => item.id === model);
  // Context remains valid while idle; it is the most recent reported sample.
  // The bridge clears it on reconnect or a model/settings change.
  const contextFresh = runtime?.context != null;
  useEffect(() => {
    if (!usable) { setRuntimeError(true); return; }
    let active = true;
    const timer = setTimeout(() => {
      void callbacks.current.onLoadRuntime().then(value => { if (active) { setRuntime(value); setRuntimeError(false); } })
        .catch(() => { if (active) setRuntimeError(true); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [props.revision, usable, props.session.session_ref]);
  async function openPanel(next: 'goal' | 'model', seed = '') {
    if (inflight.current) return;
    setPanel(next); setError(''); setNotice(''); setReview(null);
    if (next === 'goal') { if (seed) setObjective(seed); return; }
    if (!usable) return;
    inflight.current = true; setBusy(true);
    try {
      const value = await props.onLoadControl(); setControl(value);
      const selected = value.models.find(item => item.id === value.model) ?? value.models[0];
      setModel(selected?.id ?? ''); setEffort(selected?.supported_efforts.includes(value.reasoning_effort ?? '') ? value.reasoning_effort! : selected?.default_effort ?? '');
    } catch { setError('暂时无法读取模型列表，请重试。'); }
    finally { inflight.current = false; setBusy(false); }
  }
  useEffect(() => { if (props.shortcut) void openPanel(props.shortcut.command, props.shortcut.text); }, [props.shortcut?.nonce]);
  async function saveModel() {
    if (!usable || inflight.current || !currentModel?.supported_efforts.includes(effort)) return;
    inflight.current = true; setBusy(true); setError('');
    try { const value = await props.onUpdateControl(model, effort); setControl(value); setNotice('模型与思考强度已更新，后续回合生效。'); setPanel(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '切换失败，请刷新后确认当前设置。'); }
    finally { inflight.current = false; setBusy(false); }
  }
  function reviewGoal(action: CodexGoalInput['action']) {
    setError('');
    if (action === 'set' && (!objective.trim() || objective.trim().length > 4000)) { setError('请填写目标，最多 4000 字符。'); return; }
    const tokenBudget = budget.trim() ? Number(budget) : undefined;
    if (action === 'set' && tokenBudget !== undefined && (!/^\d+$/.test(budget.trim()) || !Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) { setError('Token 预算须为正整数，或留空。'); return; }
    setReview({ action, ...(action === 'set' ? { objective: objective.trim(), ...(tokenBudget !== undefined ? { token_budget: tokenBudget } : {}) } : {}), idempotency_key: operationKey() });
  }
  async function saveGoal() {
    if (!review || !usable || inflight.current) return;
    inflight.current = true; setBusy(true); setError('');
    try {
      const result = await props.onUpdateGoal(review);
      setRuntime(value => ({ session_ref: props.session.session_ref, context: null, weekly: null, ...value, goal: result.goal, goal_available: true, refreshed_at: new Date().toISOString() }));
      setReview(null); setPanel(null); setNotice('Goal 状态已更新。');
    } catch { setError('未收到成功确认。请先刷新 Goal 状态；重试会使用同一个请求编号。'); }
    finally { inflight.current = false; setBusy(false); }
  }
  const goal = runtime?.goal;
  const metricReady = usable && !runtimeError;
  return <View style={styles.section}>
    <View style={styles.metrics}>
      <Text style={styles.meta}>Context used {metricReady && contextFresh ? `≈ ${runtime!.context!.used_percent}%` : '—'}</Text>
      <Text style={styles.meta}>Weekly left {metricReady && runtime?.weekly ? `${Math.round(runtime.weekly.remaining_percent)}%` : '—'}</Text>
    </View>
    {!metricReady || !runtime?.context || !runtime?.weekly ? <Text style={styles.small}>— 暂不可用；上下文数据在收到会话用量更新后显示。</Text> : null}
    <View style={styles.buttons}>
      <Pressable accessibilityRole="button" onPress={() => void openPanel('goal')} style={styles.button}><Text style={styles.buttonText}>/goal{goal ? ` · ${goalLabels[goal.status]}` : ''}</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => void openPanel('model')} style={styles.button}><Text style={styles.buttonText}>/model{control?.model ? ` · ${control.reasoning_effort}` : ''}</Text></Pressable>
    </View>
    {control?.model ? <Text style={styles.small}>{control.model}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={styles.meta}>{notice}</Text> : null}
    {panel ? <View style={styles.panel}>
      <View style={styles.metrics}><Text style={styles.title}>{panel === 'goal' ? 'Goal 目标' : '模型与思考强度'}</Text><Pressable accessibilityRole="button" disabled={busy} onPress={() => { setPanel(null); setReview(null); setError(''); }} style={styles.close}><Text style={styles.meta}>收起</Text></Pressable></View>
      {!usable ? <Text style={styles.error}>电脑离线或会话暂不可控，恢复连接后可修改。</Text> : null}
      {panel === 'model' ? <>
        {busy ? <Text style={styles.meta}>正在读取或更新…</Text> : null}
        {!control && !busy ? <Pressable accessibilityRole="button" onPress={() => void openPanel('model')} style={styles.button}><Text>重新读取模型</Text></Pressable> : null}
        <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>{control?.models.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ checked: model === item.id, disabled: busy || !usable }} disabled={busy || !usable} onPress={() => { setModel(item.id); setEffort(item.supported_efforts.includes(effort) ? effort : item.default_effort ?? ''); }} style={[styles.option, model === item.id && styles.selected]}><Text style={styles.body}>{item.display_name}</Text><Text style={styles.small}>{item.id}</Text></Pressable>)}</ScrollView>
        <Text style={styles.meta}>思考强度</Text><View style={styles.buttons}>{currentModel?.supported_efforts.map(item => <Pressable key={item} accessibilityRole="radio" accessibilityState={{ checked: effort === item, disabled: busy || !usable }} disabled={busy || !usable} onPress={() => setEffort(item)} style={[styles.button, effort === item && styles.selected]}><Text style={styles.buttonText}>{item}</Text></Pressable>)}</View>
        <Text style={styles.small}>仅修改当前会话，后续回合生效。每周额度属于该电脑登录的账户。</Text>
        <Text style={styles.small}>目标：{props.session.host_label} / {props.session.project_alias} / {props.session.session_ref.slice(-6)}</Text>
        <Pressable accessibilityRole="button" disabled={!usable || busy || !currentModel?.supported_efforts.includes(effort)} onPress={() => void saveModel()} style={[styles.primary, (!usable || busy || !currentModel?.supported_efforts.includes(effort)) && styles.disabled]}><Text style={styles.primaryText}>应用 {model || '模型'} / {effort || '强度'}</Text></Pressable>
      </> : review ? <>
        <Text style={styles.body}>{review.action === 'set' ? '启用 Goal' : review.action === 'pause' ? '暂停 Goal' : '继续 Goal'}</Text>
        <Text style={styles.meta}>{props.session.host_label} / {props.session.project_alias} / {props.session.session_ref.slice(-6)}</Text>
        <Text selectable style={styles.body}>{review.objective ?? goal?.objective}</Text>
        {review.token_budget ? <Text style={styles.meta}>预算 {review.token_budget.toLocaleString()} tokens</Text> : null}
        {review.action === 'set' && goal ? <Text style={styles.small}>新目标会替换原目标；不同目标会重新统计用量。</Text> : null}
        <Pressable accessibilityRole="button" disabled={!usable || busy} onPress={() => void saveGoal()} style={[styles.primary, (!usable || busy) && styles.disabled]}><Text style={styles.primaryText}>{busy ? '更新中…' : '确认更新 Goal'}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => setReview(null)} style={styles.close}><Text>返回修改</Text></Pressable>
      </> : <>
        {goal ? <View style={{ gap: 8 }}><Text style={styles.meta}>当前：{goalLabels[goal.status]}</Text><Text selectable style={styles.body}>{goal.objective}</Text><Text style={styles.small}>已用 {goal.tokens_used?.toLocaleString() ?? '—'} tokens{goal.token_budget ? ` / ${goal.token_budget.toLocaleString()}` : ''}</Text>
          <Pressable accessibilityRole="button" disabled={!usable || busy} onPress={() => reviewGoal(goal.status === 'active' ? 'pause' : 'resume')} style={styles.button}><Text>{goal.status === 'active' ? '暂停 Goal' : '继续 Goal'}</Text></Pressable></View> : <Text style={styles.meta}>{runtime?.goal_available ? '尚未设置目标' : 'Goal 状态暂不可用，可刷新后重试。'}</Text>}
        <TextInput accessibilityLabel="Goal 目标" value={objective} onChangeText={setObjective} placeholder="希望 Codex 持续完成什么？" multiline maxLength={4000} style={styles.input} editable={!busy} />
        <TextInput accessibilityLabel="Goal Token 预算（可选）" value={budget} onChangeText={setBudget} placeholder="Token 预算（可选）" keyboardType="number-pad" style={[styles.input, { minHeight: 48 }]} editable={!busy} />
        <Text style={styles.small}>与电脑 /goal 共用目标。尚未开始的会话，设置后可发送下一轮 Prompt。</Text>
        <Pressable accessibilityRole="button" disabled={!usable || busy || !objective.trim()} onPress={() => reviewGoal('set')} style={[styles.primary, (!usable || busy || !objective.trim()) && styles.disabled]}><Text style={styles.primaryText}>检查并启用 Goal</Text></Pressable>
      </>}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Pressable accessibilityRole="button" disabled={!usable || busy} onPress={() => { void props.onLoadRuntime().then(value => { setRuntime(value); setRuntimeError(false); setNotice('状态已刷新'); }).catch(() => setError('刷新失败，请检查电脑连接。')); }} style={styles.close}><Text style={styles.meta}>刷新状态</Text></Pressable>
    </View> : null}
  </View>;
}
const styles = StyleSheet.create({
  section: { paddingTop: 20, gap: 10 }, metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, button: { minHeight: 44, paddingHorizontal: 13, paddingVertical: 10, borderWidth: 1, borderColor: '#DDE0E4', borderRadius: 8, justifyContent: 'center' },
  buttonText: { fontSize: 14, color: '#353B44' }, meta: { fontSize: 13, lineHeight: 22, color: '#606975' }, small: { fontSize: 12, lineHeight: 20, color: '#717A86' },
  panel: { backgroundColor: '#F7F8F9', padding: 16, borderRadius: 10, gap: 12 }, title: { fontSize: 16, fontWeight: '600', color: '#25292F' }, body: { fontSize: 15, lineHeight: 24, color: '#353B44' },
  close: { minHeight: 44, justifyContent: 'center', alignItems: 'center' }, option: { padding: 12, gap: 3, borderWidth: 1, borderColor: '#E4E7EB', borderRadius: 8, marginBottom: 8 }, selected: { backgroundColor: '#E8EDF1', borderColor: '#86939F' },
  input: { backgroundColor: '#FFF', borderColor: '#DDE0E4', borderWidth: 1, borderRadius: 8, fontSize: 16, lineHeight: 24, minHeight: 96, padding: 12, textAlignVertical: 'top', color: '#25292F' },
  primary: { minHeight: 48, padding: 12, justifyContent: 'center', alignItems: 'center', backgroundColor: '#25292F', borderRadius: 8 }, primaryText: { fontSize: 15, color: '#FFF' }, disabled: { opacity: 0.4 }, error: { color: '#A34435', fontSize: 13, lineHeight: 22 },
});

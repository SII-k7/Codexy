import { useState } from 'react';
import { SessionTools } from './SessionTools';
import type { CodexSessionRuntime, CodexGoalInput, CodexGoal } from '../types';
import { Modal, Platform, SafeAreaView, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import type { AgentSession, CodexControlAction, CodexControlActionResult, CodexControlSnapshot, CodexReplySummary, RemotePromptCommand, RemotePromptMode } from '../types';
import { latestSessionPrompt, sessionLabel, sessionPhase } from '../sessionPresentation';
import { CodexReplySummaryCard } from './CodexReplySummaryCard';
import { RemotePromptComposer } from './RemotePromptComposer';
export function CodexSessionScreen(props: {
  initialReplySummary?: CodexReplySummary;
  runtimeRevision?: number;
  onLoadRuntime: () => Promise<CodexSessionRuntime>;
  onUpdateGoal: (input: CodexGoalInput) => Promise<{ goal: CodexGoal | null }>;
  latestCommand: RemotePromptCommand | null;
  online: boolean;
  session: AgentSession;
  onAcknowledge: () => void;
  onCancelPrompt: (commandId: string) => Promise<RemotePromptCommand>;
  onClose: () => void;
  onLoadControl: () => Promise<CodexControlSnapshot>;
  onLoadReplySummary: () => Promise<CodexReplySummary>;
  onRunControlAction: (
    action: CodexControlAction,
  ) => Promise<CodexControlActionResult>;
  onSendPrompt: (
    prompt: string,
    mode: RemotePromptMode,
  ) => Promise<RemotePromptCommand>;
  onUpdateControl: (
    model: string,
    reasoningEffort: string,
  ) => Promise<CodexControlSnapshot>;
}) {

  const [shortcut, setShortcut] = useState<{ command: 'goal' | 'model'; text: string; nonce: number } | null>(null);
  const latest = latestSessionPrompt(props.session);
  const phase = sessionPhase(props.session, props.online);
  const screen = <SafeAreaView style={styles.page}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回会话列表" onPress={props.onClose} style={styles.back}><Text style={styles.meta}>‹ 全部会话</Text></Pressable>
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={styles.title}>{props.session.project_alias}</Text>
        <Text style={styles.meta}>{props.session.host_label || '电脑'} · {props.session.session_ref.slice(-6)}</Text>
        <Text style={[styles.state, phase === 'running' && { color: '#347451' }, phase === 'attention' && { color: '#A15C27' }]}>{sessionLabel(props.session, props.online)}</Text>
      </View>
      {phase === 'attention' ? <Text style={styles.notice}>{props.session.state === 'needs_you' ? '当前需要处理授权或选择，请在电脑端查看。下一条指令会等待当前回合结束。' : '本轮未正常结束，请查看最近进展后决定下一步。'}</Text> : null}
      <CodexReplySummaryCard compact fallback={props.session.summary} controlStatus={props.session.control_status ?? 'setup_required'} initialSummary={props.initialReplySummary} online={props.online} sessionRef={props.session.session_ref} sessionUpdatedAt={props.session.updated_at} onLoad={props.onLoadReplySummary} />
      <View style={styles.section}><Text style={styles.label}>上一条 Prompt</Text>
        <Text selectable style={styles.prompt}>{latest?.text || '还没有同步到上一条指令。'}</Text>
        {latest ? <Text style={styles.small}>已脱敏 · {new Date(latest.captured_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</Text> : null}
      </View>
      <SessionTools session={props.session} online={props.online} revision={props.runtimeRevision ?? 0} shortcut={shortcut} onLoadRuntime={props.onLoadRuntime} onLoadControl={props.onLoadControl} onUpdateControl={props.onUpdateControl} onUpdateGoal={props.onUpdateGoal} />
      <RemotePromptComposer onSlashCommand={(command, text) => setShortcut({ command, text, nonce: Date.now() })} key={(props.session.storage_scope || '') + props.session.session_ref} compact latestCommand={props.latestCommand} online={props.online} session={props.session} onCancel={props.onCancelPrompt} onSend={props.onSendPrompt} />
    </ScrollView>
  </KeyboardAvoidingView></SafeAreaView>;
  return Platform.OS === 'web' ? screen : <Modal visible animationType="slide" onRequestClose={props.onClose}>{screen}</Modal>;
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#FFF' }, content: { paddingHorizontal: 24, paddingBottom: 40, width: '100%', maxWidth: 660, alignSelf: 'center' },
  back: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start' }, heading: { gap: 8, paddingTop: 12, paddingBottom: 24 },
  title: { fontSize: 27, lineHeight: 35, fontWeight: '600', color: '#202124' }, meta: { fontSize: 14, color: '#6B7280' }, state: { fontSize: 14, fontWeight: '500', color: '#535C68' },
  notice: { fontSize: 14, lineHeight: 23, color: '#87501E', paddingBottom: 20 }, section: { paddingVertical: 22, gap: 12, borderBottomWidth: 1, borderColor: '#ECEEF0' },
  label: { fontSize: 16, fontWeight: '600', color: '#25292F' }, prompt: { fontSize: 16, lineHeight: 26, color: '#353B44' }, small: { fontSize: 12, color: '#747B85' },
});

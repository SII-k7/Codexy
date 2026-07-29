import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentSession, AgentState } from '../types';

const STATE_LABELS: Record<AgentState, string> = {
  working: '正在工作',
  needs_you: '需要你决定',
  turn_finished: '本轮结束',
  subtask_completed: '子任务完成',
  completed: '目标完成',
  failed: '运行失败',
  interrupted: '已中断',
  background_ended: '后台结束',
  session_ended: '会话结束',
};

const CONTROL_LABELS: Record<
  NonNullable<AgentSession['control_status']>,
  string
> = {
  ready: '手机可控',
  observe_only: '仅观察',
  checking: '检查中',
  setup_required: '待启用',
  unsupported: '仅同步',
  error: '桥接异常',
};

function phaseIndex(state: AgentState): number {
  if (state === 'working') return 0;
  if (state === 'needs_you') return 1;
  return 2;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function CodexSessionCard(props: {
  index: number;
  onPress: () => void;
  session: AgentSession;
}) {
  const needsYou = props.session.state === 'needs_you';
  const latestPrompt = props.session.prompts.at(-1)?.text;
  const sessionSuffix = props.session.session_ref.slice(-4).toUpperCase();
  const controlStatus = props.session.control_status ?? 'setup_required';

  return (
    <Pressable
      accessibilityHint="打开这个 CLI 的最近 Prompt 和项目思路整理"
      accessibilityLabel={`${props.session.project_alias}，${STATE_LABELS[props.session.state]}`}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.card,
        needsYou && styles.cardUrgent,
        pressed && styles.cardPressed,
      ]}
    >
      <View style={styles.header}>
        <View style={styles.identity}>
          <Text
            style={[styles.index, needsYou && styles.inverseMuted]}
          >
            CLI {String(props.index + 1).padStart(2, '0')}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.project, needsYou && styles.inverseText]}
          >
            {props.session.project_alias}
          </Text>
        </View>
        <View style={styles.statusColumn}>
          <Text
            style={[styles.status, needsYou && styles.inverseText]}
          >
            {STATE_LABELS[props.session.state]}
          </Text>
          <Text
            style={[styles.time, needsYou && styles.inverseMuted]}
          >
            {formatTime(props.session.updated_at)}
          </Text>
        </View>
      </View>

      <View style={styles.phaseTrack}>
        {['工作中', '等你', '本轮结束'].map((label, index) => {
          const active = phaseIndex(props.session.state) === index;
          return (
            <View
              key={label}
              style={[
                styles.phaseStep,
                active && styles.phaseStepActive,
                needsYou && active && styles.phaseStepUrgent,
              ]}
            >
              <Text
                style={[
                  styles.phaseStepText,
                  active && styles.phaseStepTextActive,
                ]}
              >
                {label}
              </Text>
            </View>
          );
        })}
      </View>

      <View style={styles.footer}>
        <Text
          numberOfLines={2}
          style={[styles.prompt, needsYou && styles.inverseMuted]}
        >
          {latestPrompt ?? props.session.summary}
        </Text>
        <View style={styles.footerMeta}>
          <Text
            style={[styles.promptCount, needsYou && styles.inverseMuted]}
          >
            {props.session.prompt_count}/10
          </Text>
          <Text
            style={[
              styles.controlStatus,
              controlStatus === 'ready' && styles.controlStatusReady,
              needsYou && styles.inverseMuted,
            ]}
          >
            {CONTROL_LABELS[controlStatus]}
          </Text>
          <Text
            style={[styles.sessionCode, needsYou && styles.inverseMuted]}
          >
            {sessionSuffix} →
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#F3F2ED',
    borderColor: '#D2D0C8',
    borderWidth: 1,
    minHeight: 124,
    padding: 16,
  },
  cardUrgent: { backgroundColor: '#111111', borderColor: '#111111' },
  cardPressed: { opacity: 0.78 },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  identity: { flex: 1 },
  index: {
    color: '#77756F',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.3,
  },
  project: {
    color: '#171717',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 6,
  },
  statusColumn: { alignItems: 'flex-end' },
  status: { color: '#333333', fontSize: 11, fontWeight: '700' },
  time: {
    color: '#858585',
    fontSize: 9,
    fontVariant: ['tabular-nums'],
    marginTop: 6,
  },
  phaseTrack: {
    flexDirection: 'row',
    gap: 5,
    marginTop: 15,
  },
  phaseStep: {
    alignItems: 'center',
    borderColor: '#D4D1C8',
    borderWidth: 1,
    flex: 1,
    paddingVertical: 5,
  },
  phaseStepActive: { backgroundColor: '#5D625C', borderColor: '#5D625C' },
  phaseStepUrgent: { backgroundColor: '#B34A40', borderColor: '#B34A40' },
  phaseStepText: { color: '#85827A', fontSize: 8, fontWeight: '700' },
  phaseStepTextActive: { color: '#FFFFFF' },
  footer: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginTop: 12,
  },
  prompt: {
    color: '#62615D',
    flex: 1,
    fontSize: 11,
    lineHeight: 17,
  },
  footerMeta: { alignItems: 'flex-end', gap: 5 },
  promptCount: {
    color: '#77756F',
    fontSize: 9,
    fontVariant: ['tabular-nums'],
  },
  controlStatus: {
    color: '#77756F',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  controlStatusReady: { color: '#2E7144' },
  sessionCode: {
    color: '#55534E',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.7,
  },
  inverseText: { color: '#FFFFFF' },
  inverseMuted: { color: '#BEBEBE' },
});

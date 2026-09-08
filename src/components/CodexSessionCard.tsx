import { StyleSheet, Text, View } from 'react-native';

import type {
  AgentSession,
  AgentState,
  CodexReplySummary,
} from '../types';
import { SpringPressable } from './SpringPressable';

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

const USER_NEXT_STEPS: Record<AgentState, string> = {
  working: '等待 Agent 更新',
  needs_you: '打开会话查看并处理',
  turn_finished: '复核结果，决定是否继续',
  subtask_completed: '查看产出，接回主线',
  completed: '验收结果',
  failed: '查看原因并重试',
  interrupted: '确认是否重新开始',
  background_ended: '确认是否重新开始',
  session_ended: '确认是否重新开始',
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

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

interface CodexSessionCardBaseProps {
  index: number;
  onPress: () => void;
  replySummary?: CodexReplySummary;
  session: AgentSession;
}

type CodexSessionCardHideProps =
  | {
      onHide: () => void;
      onLongPress?: () => void;
    }
  | {
      onHide?: never;
      /** @deprecated Pass the same handler as onHide. */
      onLongPress: () => void;
    };

type CodexSessionCardProps =
  CodexSessionCardBaseProps & CodexSessionCardHideProps;

export function CodexSessionCard(props: CodexSessionCardProps) {
  const needsYou = props.session.state === 'needs_you';
  const onHide = props.onHide ?? props.onLongPress;
  const agentUpdate =
    props.replySummary?.available && props.replySummary.headline
      ? props.replySummary.headline
      : props.session.summary;
  const userNextStep = USER_NEXT_STEPS[props.session.state];
  const controlStatus = props.session.control_status ?? 'setup_required';

  return (
    <View style={[styles.card, needsYou && styles.cardUrgent]}>
      <SpringPressable
        accessibilityHint="按下打开会话详情"
        accessibilityLabel={`${props.session.project_alias}。状态：${STATE_LABELS[props.session.state]}。Agent 摘要：${agentUpdate}。你的下一步：${userNextStep}`}
        accessibilityRole="button"
        accessibilityState={{ busy: props.session.state === 'working' }}
        focusable
        onPress={props.onPress}
        style={styles.openArea}
      >
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <View style={styles.header}>
            <View style={styles.identity}>
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

          <View style={styles.agentBlock}>
            <Text
              numberOfLines={2}
              style={[styles.agentUpdate, needsYou && styles.inverseText]}
            >
              {agentUpdate}
            </Text>
          </View>

          <View style={[styles.nextRow, needsYou && styles.nextRowUrgent]}>
            <Text style={[styles.nextLabel, needsYou && styles.inverseMuted]}>
              下一步
            </Text>
            <Text
              numberOfLines={2}
              style={[styles.nextStep, needsYou && styles.inverseText]}
            >
              {userNextStep}
            </Text>
          </View>
        </View>
      </SpringPressable>

      <View
        style={[
          styles.cardActionRow,
          needsYou && styles.cardActionRowUrgent,
        ]}
      >
        {controlStatus !== 'ready' ? (
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={[styles.controlStatus, needsYou && styles.inverseMuted]}
          >
            {CONTROL_LABELS[controlStatus]}
          </Text>
        ) : (
          <View />
        )}
        <SpringPressable
          accessibilityHint="仅从工作台列表隐藏；待处理告警仍会保留"
          accessibilityLabel={`隐藏 ${props.session.project_alias} 会话`}
          accessibilityRole="button"
          focusable
          onPress={onHide}
          pressedScale={0.96}
          style={[
            styles.hideButton,
            needsYou && styles.hideButtonUrgent,
          ]}
        >
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={[
              styles.hideButtonText,
              needsYou && styles.hideButtonTextUrgent,
            ]}
          >
            隐藏
          </Text>
        </SpringPressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#F3F2ED',
    borderColor: '#D2D0C8',
    borderWidth: 1,
    userSelect: 'none',
  },
  cardUrgent: { backgroundColor: '#111111', borderColor: '#111111' },
  openArea: {
    minHeight: 124,
    padding: 15,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  identity: { flex: 1 },
  project: {
    color: '#171717',
    fontSize: 17,
    fontWeight: '800',
  },
  statusColumn: { alignItems: 'flex-end' },
  status: { color: '#333333', fontSize: 12, fontWeight: '800' },
  time: {
    color: '#69675F',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    marginTop: 5,
  },
  agentBlock: { marginTop: 13 },
  agentUpdate: {
    color: '#2E2D29',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 19,
  },
  nextRow: {
    alignItems: 'flex-start',
    borderTopColor: '#D8D6CE',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginTop: 13,
    paddingTop: 11,
  },
  nextRowUrgent: { borderTopColor: '#3D3D3D' },
  nextLabel: {
    color: '#77746C',
    fontSize: 11,
    fontWeight: '800',
    paddingTop: 1,
    width: 44,
  },
  nextStep: {
    color: '#3E5142',
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 19,
  },
  controlStatus: {
    color: '#77756F',
    fontSize: 11,
    fontWeight: '700',
  },
  cardActionRow: {
    alignItems: 'center',
    borderTopColor: '#D2D0C8',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  cardActionRowUrgent: { borderTopColor: '#3D3D3D' },
  hideButton: {
    alignItems: 'center',
    borderColor: '#AAA79E',
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 72,
    paddingHorizontal: 14,
  },
  hideButtonUrgent: {
    backgroundColor: '#1B1B1B',
    borderColor: '#666666',
  },
  hideButtonText: {
    color: '#393732',
    fontSize: 11,
    fontWeight: '800',
  },
  hideButtonTextUrgent: { color: '#FFFFFF' },
  inverseText: { color: '#FFFFFF' },
  inverseMuted: { color: '#BEBEBE' },
});

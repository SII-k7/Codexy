import { StyleSheet, Text, View } from 'react-native';

import type { AttentionItem } from '../attention';
import { SpringPressable } from './SpringPressable';

const KIND_LABELS: Record<AttentionItem['kind'], string> = {
  decision: '决定',
  failure: '修复',
  resume: '继续',
  review: '复核',
  verify: '验收',
};

export function AttentionQueue(props: {
  items: AttentionItem[];
  onOpen: (sessionRef: string) => void;
  onSummarize?: (sessionRef: string) => void;
  summarizingSessionRef?: string | null;
  workingCount: number;
}) {
  const primary = props.items[0];

  if (!primary) {
    const quietMessage = props.workingCount
      ? `${props.workingCount} 个 Agent 正在工作，暂时无需处理。`
      : '目前没有运行中或等待复核的会话。';

    return (
      <View
        accessibilityLabel={`注意力队列为空。${quietMessage}`}
        accessible
        style={styles.quietCard}
      >
        <Text style={styles.quietEyebrow}>注意力已清空</Text>
        <Text style={styles.quietTitle}>现在不用管 Codex</Text>
        <Text style={styles.quietBody}>
          {props.workingCount
            ? `${props.workingCount} 个 Agent 正在工作，需要你时会提醒。`
            : '目前没有需要处理的会话。'}
        </Text>
      </View>
    );
  }

  const summarizing =
    props.summarizingSessionRef === primary.sessionRef;
  const summaryActionLabel = summarizing
    ? '正在电脑本机提炼 Agent 速览'
    : primary.summaryAvailable
      ? '更新本轮摘要'
      : '生成本轮摘要';

  return (
    <View style={styles.container}>
      <SpringPressable
        accessibilityHint="按下打开当前优先级最高的会话"
        accessibilityLabel={`${primary.projectAlias}。建议操作：${primary.actionLabel}。Agent 摘要：${primary.agentUpdate}。你的下一步：${primary.nextMove}`}
        accessibilityRole="button"
        focusable
        onPress={() => props.onOpen(primary.sessionRef)}
        style={[
          styles.primaryCard,
          primary.urgent && styles.primaryCardUrgent,
        ]}
      >
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <View style={styles.primaryHeading}>
            <Text
              style={[
                styles.primaryEyebrow,
                primary.urgent && styles.primaryEyebrowUrgent,
              ]}
            >
              优先处理 · 1/{props.items.length}
            </Text>
            <Text
              style={[
                styles.kindBadge,
                primary.urgent && styles.kindBadgeUrgent,
              ]}
            >
              {KIND_LABELS[primary.kind]}
            </Text>
          </View>

          <Text
            style={[
              styles.project,
              primary.urgent && styles.inverseText,
            ]}
          >
            {primary.projectAlias}
          </Text>
          <Text
            style={[
              styles.actionTitle,
              primary.urgent && styles.inverseText,
            ]}
          >
            {primary.actionLabel}
          </Text>

          <View
            style={[
              styles.signalRows,
              primary.urgent && styles.signalRowsUrgent,
            ]}
          >
            <View style={styles.signalRow}>
              <Text
                style={[
                  styles.signalLabel,
                  primary.urgent && styles.inverseMuted,
                ]}
              >
                Agent
              </Text>
              <Text
                numberOfLines={2}
                style={[
                  styles.signalText,
                  primary.urgent && styles.inverseBody,
                ]}
              >
                {primary.agentUpdate}
              </Text>
            </View>
            <View style={styles.signalRow}>
              <Text
                style={[
                  styles.signalLabel,
                  primary.urgent && styles.inverseMuted,
                ]}
              >
                你
              </Text>
              <Text
                numberOfLines={2}
                style={[
                  styles.nextText,
                  primary.urgent && styles.inverseText,
                ]}
              >
                {primary.nextMove}
              </Text>
            </View>
          </View>

          <Text
            style={[
              styles.openAction,
              primary.urgent && styles.openActionUrgent,
              primary.urgent && styles.inverseText,
            ]}
          >
            打开会话
          </Text>
        </View>
      </SpringPressable>

      {primary.canSummarize &&
      primary.kind !== 'decision' &&
      props.onSummarize ? (
        <SpringPressable
          accessibilityHint="按需从电脑读取并脱敏最新一轮回复"
          accessibilityLabel={summaryActionLabel}
          accessibilityRole="button"
          accessibilityState={{ busy: summarizing, disabled: summarizing }}
          disabled={summarizing}
          focusable
          onPress={() => props.onSummarize?.(primary.sessionRef)}
          style={styles.summaryAction}
        >
          <Text style={styles.summaryActionTitle}>
            {summarizing ? '正在本机提炼…' : summaryActionLabel}
          </Text>
        </SpringPressable>
      ) : null}

      {props.items.length > 1 ? (
        <View style={styles.laterList}>
          <View style={styles.laterHeading}>
            <Text style={styles.laterLabel}>接下来</Text>
            <Text style={styles.laterCount}>
              还有 {props.items.length - 1} 项
            </Text>
          </View>
          {props.items.slice(1).map((item) => (
            <SpringPressable
              accessibilityHint="按下打开这条会话"
              accessibilityLabel={`${item.projectAlias}。建议操作：${item.actionLabel}。Agent 摘要：${item.agentUpdate}。你的下一步：${item.nextMove}`}
              accessibilityRole="button"
              focusable
              key={item.sessionRef}
              onPress={() => props.onOpen(item.sessionRef)}
              style={styles.laterRow}
            >
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={styles.laterCopy}
              >
                <Text numberOfLines={1} style={styles.laterProject}>
                  {item.projectAlias}
                </Text>
                <Text numberOfLines={1} style={styles.laterAction}>
                  {item.actionLabel}
                </Text>
              </View>
              <Text
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={styles.laterKind}
              >
                {KIND_LABELS[item.kind]}
              </Text>
            </SpringPressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 18 },
  primaryCard: {
    backgroundColor: '#DDE8DE',
    borderColor: '#BCD0BF',
    borderWidth: 1,
    padding: 17,
  },
  primaryCardUrgent: {
    backgroundColor: '#111111',
    borderColor: '#111111',
  },
  primaryHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  primaryEyebrow: {
    color: '#4E7356',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  primaryEyebrowUrgent: { color: '#E36C60' },
  kindBadge: {
    backgroundColor: '#C8DACB',
    color: '#36563E',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.4,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  kindBadgeUrgent: {
    backgroundColor: '#3A211F',
    color: '#F18478',
  },
  project: {
    color: '#4D6652',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.7,
    marginTop: 15,
  },
  actionTitle: {
    color: '#1F3524',
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.4,
    lineHeight: 31,
    marginTop: 4,
  },
  signalRows: {
    borderTopColor: '#BFD0C2',
    borderTopWidth: 1,
    gap: 10,
    marginTop: 15,
    paddingTop: 13,
  },
  signalRowsUrgent: { borderTopColor: '#3D3D3D' },
  signalRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  signalLabel: {
    color: '#5E655A',
    fontSize: 11,
    fontWeight: '800',
    paddingTop: 1,
    width: 42,
  },
  signalText: {
    color: '#3E5142',
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
  },
  nextText: {
    color: '#4D6251',
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 19,
  },
  openAction: {
    borderTopColor: '#BFD0C2',
    borderTopWidth: 1,
    color: '#274B31',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 14,
    paddingTop: 13,
  },
  openActionUrgent: { borderTopColor: '#3D3D3D' },
  inverseText: { color: '#FFFFFF' },
  inverseMuted: { color: '#8F8F8F' },
  inverseBody: { color: '#C8C8C8' },
  laterList: {
    borderColor: '#D2D0C8',
    borderTopWidth: 0,
    borderWidth: 1,
    paddingHorizontal: 14,
  },
  summaryAction: {
    alignItems: 'center',
    borderColor: '#D2D0C8',
    borderTopWidth: 0,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  summaryActionTitle: {
    color: '#393732',
    fontSize: 11,
    fontWeight: '800',
  },
  laterHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 7,
    paddingTop: 13,
  },
  laterLabel: {
    color: '#55534D',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  laterCount: { color: '#69665F', fontSize: 9 },
  laterRow: {
    alignItems: 'center',
    borderTopColor: '#E0DED7',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 11,
    minHeight: 64,
    paddingVertical: 10,
  },
  laterCopy: { flex: 1 },
  laterProject: { color: '#23221F', fontSize: 13, fontWeight: '800' },
  laterAction: {
    color: '#3F3D38',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 17,
    marginTop: 4,
  },
  laterKind: {
    backgroundColor: '#E6E3DC',
    color: '#69665F',
    fontSize: 10,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  quietCard: {
    backgroundColor: '#EBE9E2',
    borderColor: '#D4D1C8',
    borderWidth: 1,
    marginTop: 18,
    padding: 17,
  },
  quietEyebrow: {
    color: '#77736A',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  quietTitle: {
    color: '#282722',
    fontSize: 20,
    fontWeight: '800',
    marginTop: 8,
  },
  quietBody: {
    color: '#68655D',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 7,
  },
});

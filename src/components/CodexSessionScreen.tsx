import {
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type {
  AgentSession,
  AgentState,
  RemotePromptCommand,
  RemotePromptMode,
} from '../types';
import { buildLocalBrief } from '../intent';
import { RemotePromptComposer } from './RemotePromptComposer';

const STATE_LABELS: Record<AgentState, string> = {
  working: '正在工作',
  needs_you: '需要你决定',
  turn_finished: '本轮回应结束',
  subtask_completed: '子任务完成',
  completed: '目标已完成',
  failed: '运行失败',
  interrupted: '已中断',
  background_ended: '后台会话结束',
  session_ended: '会话结束',
};

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function phaseIndex(state: AgentState): number {
  if (state === 'working') return 0;
  if (state === 'needs_you') return 1;
  return 2;
}

export function CodexSessionScreen(props: {
  latestCommand: RemotePromptCommand | null;
  online: boolean;
  session: AgentSession;
  onAcknowledge: () => void;
  onCancelPrompt: (commandId: string) => Promise<RemotePromptCommand>;
  onClose: () => void;
  onSendPrompt: (
    prompt: string,
    mode: RemotePromptMode,
  ) => Promise<RemotePromptCommand>;
}) {
  const brief = buildLocalBrief(props.session);
  const needsYou = props.session.state === 'needs_you';
  const sessionSuffix = props.session.session_ref.slice(-6).toUpperCase();

  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      presentationStyle="pageSheet"
      visible
    >
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content}>
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            style={styles.closeButton}
          >
            <Text style={styles.closeButtonText}>返回工作台</Text>
          </Pressable>

          <View style={styles.headingRow}>
            <View style={styles.headingBody}>
              <Text style={styles.eyebrow}>
                CODEX CLI · {sessionSuffix}
              </Text>
              <Text style={styles.title}>{props.session.project_alias}</Text>
            </View>
            <View
              style={[
                styles.stateBadge,
                needsYou && styles.stateBadgeUrgent,
              ]}
            >
              <Text
                style={[
                  styles.stateBadgeText,
                  needsYou && styles.stateBadgeTextUrgent,
                ]}
              >
                {STATE_LABELS[props.session.state]}
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
          <View style={styles.progressMeta}>
            <Text style={styles.progressText}>{props.session.summary}</Text>
            <Text style={styles.progressTime}>
              {formatTime(props.session.updated_at)}
            </Text>
          </View>
          <Text style={styles.progressCaveat}>离散状态轨道，不代表完成百分比。</Text>

          {needsYou ? (
            <>
              <Text style={styles.attentionNote}>
                Codexy 不会替你批准工具调用。请在电脑端完成决定；在真正继续前，这条轨道会一直保留。
              </Text>
              {props.session.acknowledged_at ? (
                <View style={styles.acknowledgedCard}>
                  <Text style={styles.acknowledgedText}>
                    已看到提醒 · 仍等待电脑端处理
                  </Text>
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  onPress={props.onAcknowledge}
                  style={styles.urgentButton}
                >
                  <Text style={styles.urgentButtonText}>我知道了，保留等待状态</Text>
                </Pressable>
              )}
            </>
          ) : null}

          <RemotePromptComposer
            latestCommand={props.latestCommand}
            online={props.online}
            onCancel={props.onCancelPrompt}
            onSend={props.onSendPrompt}
            session={props.session}
            suggestedPrompt={brief.latest ? brief.suggestedPrompt : undefined}
          />

          <Text style={styles.sectionLabel}>项目思路整理</Text>
          {brief.latest ? (
            <>
              <View style={styles.focusCard}>
                <View style={styles.findingHeading}>
                  <Text style={styles.cardLabel}>当前焦点</Text>
                  <Text style={styles.sourceBadge}>{brief.latestSource}</Text>
                </View>
                <Text style={styles.focusText}>{brief.latest}</Text>
                <View style={styles.briefStats}>
                  <Text style={styles.briefStat}>
                    {brief.chronological.length} 条上下文
                  </Text>
                  <Text style={styles.briefStat}>
                    {brief.constraints.length} 项约束
                  </Text>
                  <Text style={styles.briefStat}>
                    {brief.unresolved.length} 个未决
                  </Text>
                </View>
              </View>

              <Text style={styles.subsectionLabel}>关键约束</Text>
              {brief.constraints.length ? (
                brief.constraints.map((item) => (
                  <View key={`${item.source}-${item.text}`} style={styles.finding}>
                    <Text style={styles.sourceBadge}>{item.source}</Text>
                    <Text style={styles.briefItem}>{item.text}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.emptyText}>最近输入中没有明确的硬约束措辞。</Text>
              )}

              <Text style={styles.subsectionLabel}>已形成的决定</Text>
              {brief.decisions.length ? (
                brief.decisions.map((item) => (
                  <View key={`${item.source}-${item.text}`} style={styles.finding}>
                    <Text style={styles.sourceBadge}>{item.source}</Text>
                    <Text style={styles.briefItem}>{item.text}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.emptyText}>最近输入中没有明显的决定性措辞。</Text>
              )}

              <Text style={styles.subsectionLabel}>仍像问题的部分</Text>
              {brief.unresolved.length ? (
                brief.unresolved.map((item) => (
                  <View key={`${item.source}-${item.text}`} style={styles.finding}>
                    <Text style={styles.sourceBadge}>{item.source}</Text>
                    <Text style={styles.briefItem}>{item.text}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.emptyText}>最近输入中没有明显的未决问句。</Text>
              )}

              <Text style={styles.subsectionLabel}>建议的下一条 Prompt</Text>
              <Text selectable style={styles.suggestedPrompt}>
                {brief.suggestedPrompt}
              </Text>
              <Text style={styles.reviewNote}>
                只根据你的最近 10 条指令整理，没有读取助手回复，因此可能不知道实际完成到了哪里。P01–P10
                可追溯到下方原文；建议不会自动提交。
              </Text>
            </>
          ) : (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>等待第一条 Prompt</Text>
              <Text style={styles.emptyText}>
                在这个 CLI 下一次发送指令后，经过脱敏的记录会出现在这里。
              </Text>
            </View>
          )}

          <View style={styles.promptHeading}>
            <Text style={styles.sectionLabel}>最近 Prompt</Text>
            <Text style={styles.promptCount}>
              {brief.chronological.length}/10
            </Text>
          </View>
          {brief.chronological.length ? (
            brief.chronological.map((prompt, index) => (
              <View key={prompt.prompt_id} style={styles.promptItem}>
                <View style={styles.promptMeta}>
                  <Text style={styles.promptIndex}>
                    {String(index + 1).padStart(2, '0')}
                  </Text>
                  <Text style={styles.promptTime}>
                    {formatTime(prompt.captured_at)}
                  </Text>
                </View>
                <Text selectable style={styles.promptText}>
                  {prompt.text}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.emptyText}>尚未同步 Prompt。</Text>
          )}

          <View style={styles.privacyCard}>
            <Text style={styles.privacyTitle}>独立的私有回放通道</Text>
            <Text style={styles.privacyText}>
              仅保留脱敏后的用户输入，最多 10 条并在 24 小时后自动清理。代码块、路径、链接、邮箱和疑似密钥会先在电脑端替换；状态推送通道仍然看不到 Prompt。
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#FFFFFF', flex: 1 },
  content: {
    alignSelf: 'center',
    maxWidth: 640,
    paddingBottom: 60,
    paddingHorizontal: 22,
    paddingTop: 18,
    width: '100%',
  },
  closeButton: {
    alignSelf: 'flex-end',
    borderColor: '#CFCFCF',
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  closeButtonText: { color: '#333333', fontSize: 12, fontWeight: '600' },
  headingRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginTop: 42,
  },
  headingBody: { flex: 1 },
  eyebrow: {
    color: '#737373',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
  },
  title: {
    color: '#111111',
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 38,
    marginTop: 10,
  },
  stateBadge: {
    backgroundColor: '#ECEBE6',
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  stateBadgeUrgent: { backgroundColor: '#111111' },
  stateBadgeText: { color: '#4E4E49', fontSize: 10, fontWeight: '700' },
  stateBadgeTextUrgent: { color: '#FFFFFF' },
  phaseTrack: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 28,
  },
  phaseStep: {
    alignItems: 'center',
    borderColor: '#D8D5CC',
    borderWidth: 1,
    flex: 1,
    paddingVertical: 8,
  },
  phaseStepActive: { backgroundColor: '#5E625D', borderColor: '#5E625D' },
  phaseStepUrgent: { backgroundColor: '#A33A32', borderColor: '#A33A32' },
  phaseStepText: { color: '#87847C', fontSize: 9, fontWeight: '700' },
  phaseStepTextActive: { color: '#FFFFFF' },
  progressMeta: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginTop: 10,
  },
  progressText: {
    color: '#444444',
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
  },
  progressTime: { color: '#878787', fontSize: 10 },
  progressCaveat: {
    color: '#999999',
    fontSize: 9,
    marginTop: 7,
  },
  attentionNote: {
    backgroundColor: '#F2E7E4',
    color: '#70433E',
    fontSize: 10,
    lineHeight: 17,
    marginTop: 16,
    padding: 12,
  },
  urgentButton: {
    alignItems: 'center',
    backgroundColor: '#111111',
    marginTop: 18,
    paddingVertical: 14,
  },
  urgentButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  acknowledgedCard: {
    borderColor: '#BDB9B0',
    borderWidth: 1,
    marginTop: 10,
    padding: 13,
  },
  acknowledgedText: { color: '#5F5C55', fontSize: 11, fontWeight: '700' },
  sectionLabel: {
    color: '#777777',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginTop: 34,
    textTransform: 'uppercase',
  },
  focusCard: {
    backgroundColor: '#F1F0EB',
    borderColor: '#DFDDD5',
    borderWidth: 1,
    marginTop: 12,
    padding: 17,
  },
  cardLabel: {
    color: '#77756D',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  findingHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  finding: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 9,
    marginTop: 9,
  },
  sourceBadge: {
    backgroundColor: '#DEDBD2',
    color: '#68645B',
    fontSize: 8,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  focusText: {
    color: '#1E1E1B',
    fontSize: 15,
    lineHeight: 24,
    marginTop: 9,
  },
  briefStats: {
    borderTopColor: '#D6D3CA',
    borderTopWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 14,
    paddingTop: 11,
  },
  briefStat: { color: '#77736A', fontSize: 9, fontWeight: '700' },
  subsectionLabel: {
    color: '#777777',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginTop: 25,
  },
  briefItem: {
    color: '#444444',
    flex: 1,
    fontSize: 13,
    lineHeight: 21,
  },
  suggestedPrompt: {
    backgroundColor: '#111111',
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 23,
    marginTop: 10,
    padding: 17,
  },
  reviewNote: {
    color: '#858585',
    fontSize: 10,
    lineHeight: 17,
    marginTop: 10,
  },
  emptyCard: {
    borderColor: '#D5D5D5',
    borderWidth: 1,
    marginTop: 12,
    padding: 17,
  },
  emptyTitle: { color: '#222222', fontSize: 14, fontWeight: '700' },
  emptyText: {
    color: '#777777',
    fontSize: 12,
    lineHeight: 19,
    marginTop: 7,
  },
  promptHeading: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  promptCount: {
    color: '#777777',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  promptItem: {
    borderTopColor: '#D8D8D8',
    borderTopWidth: 1,
    marginTop: 12,
    paddingTop: 15,
  },
  promptMeta: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  promptIndex: {
    color: '#555555',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },
  promptTime: { color: '#969696', fontSize: 9 },
  promptText: {
    color: '#333333',
    fontSize: 13,
    lineHeight: 21,
    marginTop: 8,
  },
  privacyCard: {
    backgroundColor: '#F4F3EE',
    borderColor: '#DFDDD4',
    borderWidth: 1,
    marginTop: 36,
    padding: 16,
  },
  privacyTitle: { color: '#34332E', fontSize: 12, fontWeight: '700' },
  privacyText: {
    color: '#6C6960',
    fontSize: 11,
    lineHeight: 18,
    marginTop: 7,
  },
});

import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type {
  AgentSession,
  CodexReplyHighlightKind,
  CodexReplySummary,
} from '../types';

const KIND_TONES: Record<
  CodexReplyHighlightKind,
  { background: string; foreground: string }
> = {
  outcome: { background: '#DDE8D4', foreground: '#43553A' },
  verification: { background: '#D9E5E8', foreground: '#3C555B' },
  attention: { background: '#EFE0D8', foreground: '#75483E' },
  next: { background: '#E4E0ED', foreground: '#54476D' },
  detail: { background: '#E5E3DB', foreground: '#5F5B50' },
};

function formatTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function statusCopy(summary: CodexReplySummary): string {
  if (summary.current_turn_active) return '上一轮';
  if (summary.turn_status === 'failed') return '运行失败';
  if (summary.turn_status === 'interrupted') return '已中断';
  return '本轮回复';
}

export function CodexReplySummaryCard(props: {
  compact?: boolean;
  fallback?: string;
  controlStatus: NonNullable<AgentSession['control_status']>;
  initialSummary?: CodexReplySummary;
  online: boolean;
  sessionRef: string;
  sessionUpdatedAt: string;
  onLoad: () => Promise<CodexReplySummary>;
}) {
  const [summary, setSummary] = useState<CodexReplySummary | null>(
    props.initialSummary ?? null,
  );
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setSummary(await props.onLoad());
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : '无法读取最近一次 Codex 回复。',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (
      props.controlStatus !== 'ready' ||
      !props.online
    ) {
      setSummary(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    void props
      .onLoad()
      .then((next) => {
        if (active) setSummary(next);
      })
      .catch((loadError) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : '无法读取最近一次 Codex 回复。',
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    props.controlStatus,
    props.online,
    props.sessionRef,
    props.sessionUpdatedAt,
  ]);

  if (props.compact) return <View style={{ borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#ECEEF0', paddingVertical: 18, gap: 10 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text style={{ fontSize: 16, fontWeight: '600', color: '#25292F' }}>最近进展</Text>
      {props.controlStatus === 'ready' ? <Pressable accessibilityRole="button" accessibilityLabel="刷新最近进展" disabled={loading || !props.online} onPress={() => void load()} style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }}>
        <Text style={{ color: '#6B7280', fontSize: 13 }}>{loading ? '读取中…' : '刷新'}</Text>
      </Pressable> : null}
    </View>
    <Text style={{ fontSize: 16, lineHeight: 26, color: '#353B44' }}>{summary?.available ? summary.headline : props.fallback || '暂时没有进展摘要。'}</Text>
    {summary?.available ? summary.highlights.slice(0, 2).map((item, index) => <Text key={index} style={{ fontSize: 14, lineHeight: 24, color: '#646C77' }}>· {item.text}</Text>) : null}
    {summary?.available && summary.current_turn_active ? <Text style={{ fontSize: 12, color: '#747B85' }}>以上为上一轮结果，当前回合仍在推进。</Text> : null}
    {error ? <Text accessibilityRole="alert" style={{ fontSize: 13, color: '#A34435' }}>最近回复暂时无法读取，显示已同步进展。</Text> : null}
  </View>;

  if (props.controlStatus !== 'ready') {
    return (
      <View style={styles.unavailableCard}>
        <Text style={styles.unavailableTitle}>本轮结果暂不可用</Text>
        <Text style={styles.unavailableBody}>
          用 codexy 打开会话后即可生成摘要。
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.heading}>
        <View style={styles.headingCopy}>
          <Text style={styles.title}>本轮结果</Text>
        </View>
        <Pressable
          accessibilityLabel={loading ? '正在刷新回复速览' : '刷新回复速览'}
          accessibilityRole="button"
          accessibilityState={{ busy: loading, disabled: loading || !props.online }}
          disabled={loading || !props.online}
          onPress={() => void load()}
          style={styles.refreshButton}
        >
          {loading ? (
            <ActivityIndicator color="#57584F" size="small" />
          ) : (
            <Text style={styles.refreshText}>刷新</Text>
          )}
        </Pressable>
      </View>

      {!props.online ? (
        <Text style={styles.emptyBody}>
          电脑暂时不可达；恢复连接后可重新读取回复速览。
        </Text>
      ) : null}

      {summary?.available ? (
        <>
          <View style={styles.statusRow}>
            <Text
              style={[
                styles.statusBadge,
                summary.turn_status === 'failed' &&
                  styles.statusBadgeFailed,
              ]}
            >
              {statusCopy(summary)}
            </Text>
            <Text style={styles.statusTime}>
              {formatTime(summary.completed_at)}
            </Text>
          </View>
          <Text numberOfLines={3} style={styles.headline}>{summary.headline}</Text>
          {summary.highlights.length ? (
            <>
              <Pressable
                accessibilityLabel={`本轮结果详情，${summary.highlights.length} 条。${expanded ? '已展开' : '已收起'}`}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setExpanded((current) => !current)}
                style={styles.disclosure}
              >
                <Text style={styles.disclosureText}>
                  {expanded ? '收起详情' : `查看 ${summary.highlights.length} 条详情`}
                </Text>
              </Pressable>
              {expanded ? (
                <View style={styles.highlights}>
                  {summary.highlights.map((highlight, index) => {
                    const tone = KIND_TONES[highlight.kind];
                    return (
                      <View
                        key={`${highlight.kind}-${index}-${highlight.text}`}
                        style={styles.highlight}
                      >
                        <Text
                          style={[
                            styles.highlightLabel,
                            {
                              backgroundColor: tone.background,
                              color: tone.foreground,
                            },
                          ]}
                        >
                          {highlight.label}
                        </Text>
                        <Text style={styles.highlightText}>
                          {highlight.text}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </>
          ) : null}
        </>
      ) : !loading && props.online ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>
            {summary?.current_turn_active
              ? '当前回合仍在进行'
              : '还没有可提炼的最终回复'}
          </Text>
          <Text style={styles.emptyBody}>
            Codex 完成本轮最终回复后，再点一次刷新即可看到速览。
          </Text>
        </View>
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
  card: {
    backgroundColor: '#FFFFFF',
    borderColor: '#D9D7CE',
    borderWidth: 1,
    marginTop: 18,
    padding: 16,
  },
  heading: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headingCopy: { flex: 1 },
  title: {
    color: '#20201D',
    fontSize: 18,
    fontWeight: '800',
  },
  refreshButton: {
    alignItems: 'center',
    borderColor: '#C9C6BC',
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 50,
    paddingHorizontal: 9,
  },
  refreshText: {
    color: '#595850',
    fontSize: 10,
    fontWeight: '700',
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  statusBadge: {
    backgroundColor: '#DDE8D4',
    color: '#43553A',
    fontSize: 9,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 5,
  },
  statusBadgeFailed: {
    backgroundColor: '#EFE0D8',
    color: '#75483E',
  },
  statusTime: {
    color: '#69675F',
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
  headline: {
    color: '#24241F',
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 25,
    marginTop: 10,
  },
  highlights: {
    borderTopColor: '#D8D5CC',
    borderTopWidth: 1,
    gap: 10,
    marginTop: 14,
    paddingTop: 13,
  },
  disclosure: {
    alignItems: 'flex-start',
    borderTopColor: '#D8D5CC',
    borderTopWidth: 1,
    justifyContent: 'center',
    marginTop: 14,
    minHeight: 44,
  },
  disclosureText: { color: '#56534C', fontSize: 12, fontWeight: '800' },
  highlight: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 9,
  },
  highlightLabel: {
    fontSize: 8,
    fontWeight: '800',
    minWidth: 37,
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 4,
    textAlign: 'center',
  },
  highlightText: {
    color: '#4C4B44',
    flex: 1,
    fontSize: 11,
    lineHeight: 18,
  },
  emptyState: {
    borderTopColor: '#D8D5CC',
    borderTopWidth: 1,
    marginTop: 16,
    paddingTop: 14,
  },
  emptyTitle: {
    color: '#3D3C37',
    fontSize: 12,
    fontWeight: '700',
  },
  emptyBody: {
    color: '#77756D',
    fontSize: 10,
    lineHeight: 17,
    marginTop: 6,
  },
  error: {
    backgroundColor: '#F0DEDB',
    color: '#7D443D',
    fontSize: 10,
    lineHeight: 16,
    marginTop: 12,
    padding: 10,
  },
  unavailableCard: {
    borderColor: '#D5D3CB',
    borderWidth: 1,
    marginTop: 18,
    padding: 14,
  },
  unavailableTitle: {
    color: '#4E4D47',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 7,
  },
  unavailableBody: {
    color: '#858279',
    fontSize: 10,
    lineHeight: 16,
    marginTop: 6,
  },
});

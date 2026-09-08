import type {
  AgentSession,
  AgentState,
  CodexReplyHighlight,
  CodexReplySummary,
} from './types';

export type AttentionActionKind =
  | 'decision'
  | 'failure'
  | 'resume'
  | 'review'
  | 'verify';

export interface AttentionItem {
  actionLabel: string;
  agentUpdate: string;
  canSummarize: boolean;
  kind: AttentionActionKind;
  nextMove: string;
  priority: number;
  projectAlias: string;
  sessionRef: string;
  state: AgentState;
  summaryAvailable: boolean;
  updatedAt: string;
  urgent: boolean;
}

const STATE_PRIORITY: Partial<Record<AgentState, number>> = {
  needs_you: 100,
  failed: 92,
  interrupted: 82,
  completed: 74,
  turn_finished: 70,
  subtask_completed: 66,
};

function highlightFor(
  summary: CodexReplySummary | undefined,
  kinds: CodexReplyHighlight['kind'][],
): string | null {
  if (!summary?.available) return null;
  return (
    kinds
      .map((kind) =>
        summary.highlights.find((highlight) => highlight.kind === kind),
      )
      .find(Boolean)?.text ?? null
  );
}

function actionCopy(
  session: AgentSession,
  summary: CodexReplySummary | undefined,
): Pick<AttentionItem, 'actionLabel' | 'agentUpdate' | 'kind' | 'nextMove' | 'urgent'> {
  const summaryHeadline =
    summary?.available && summary.headline
      ? summary.headline
      : session.summary;
  const attention = highlightFor(summary, ['attention', 'next']);
  const next = highlightFor(summary, ['next', 'attention']);

  switch (session.state) {
    case 'needs_you':
      return {
        actionLabel: '做出决定',
        agentUpdate: session.summary,
        kind: 'decision',
        nextMove:
          '先打开这条轨道确认上下文，再回到电脑完成授权或选择。Codexy 不会替你批准。',
        urgent: true,
      };
    case 'failed':
      return {
        actionLabel: '恢复失败回合',
        agentUpdate: summaryHeadline,
        kind: 'failure',
        nextMove:
          attention ??
          '先看失败速览，确认是环境、实现还是方向问题，再决定修复或重试。',
        urgent: true,
      };
    case 'interrupted':
      return {
        actionLabel: '确认是否继续',
        agentUpdate: summaryHeadline,
        kind: 'resume',
        nextMove:
          next ??
          '确认停止是否符合预期；如果主线仍有效，用一条更具体的 Queue Prompt 恢复。',
        urgent: false,
      };
    case 'completed':
      return {
        actionLabel: '验收目标',
        agentUpdate: summaryHeadline,
        kind: 'verify',
        nextMove:
          attention ??
          '快速核对结果、验证和遗漏；确认目标真的完成后再结束这条轨道。',
        urgent: false,
      };
    case 'subtask_completed':
      return {
        actionLabel: '接回主线',
        agentUpdate: summaryHeadline,
        kind: 'review',
        nextMove:
          next ??
          '先看子任务产出，再决定把哪一项结论带回主线继续推进。',
        urgent: false,
      };
    default:
      return {
        actionLabel: '复核本轮结果',
        agentUpdate: summaryHeadline,
        kind: 'review',
        nextMove:
          next ??
          '先用十几秒看完回复速览，再选择继续、复核改动或暂时收尾。',
        urgent: false,
      };
  }
}

export function attentionPriorityFor(session: AgentSession): number {
  return STATE_PRIORITY[session.state] ?? 0;
}

export function buildAttentionQueue(
  sessions: AgentSession[],
  summaries: Record<string, CodexReplySummary> = {},
): AttentionItem[] {
  return sessions
    .filter((session) => attentionPriorityFor(session) > 0)
    .map((session) => {
      const copy = actionCopy(session, summaries[session.session_ref]);
      return {
        ...copy,
        canSummarize: session.control_status === 'ready',
        priority: attentionPriorityFor(session),
        projectAlias: session.project_alias,
        sessionRef: session.session_ref,
        state: session.state,
        summaryAvailable: summaries[session.session_ref]?.available === true,
        updatedAt: session.updated_at,
      };
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }
      return (
        new Date(right.updatedAt).getTime() -
        new Date(left.updatedAt).getTime()
      );
    });
}

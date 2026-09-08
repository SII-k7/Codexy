import type { AgentPrompt, AgentSession } from './types';

export interface LocalIntentBrief {
  challengeSummary: string;
  chronological: AgentPrompt[];
  latest: string;
  nextStepSummary: string;
  suggestedPrompt: string;
  taskSummary: string;
}

interface LocalBriefFinding {
  text: string;
  source: string;
}

function shortened(value: string, limit = 220): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trim()}…`;
}

function withoutTerminalPunctuation(value: string): string {
  return value.trim().replace(/[。！？!?；;，,\s]+$/u, '');
}

export function limitToTwoSentences(
  value: string,
  limit = 180,
): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (!compact) return '';
  const pieces =
    compact.match(/[^。！？!?]+[。！？!?]?/gu)?.filter(Boolean) ?? [compact];
  const firstTwo = pieces.slice(0, 2).join('').trim();
  const limited = shortened(firstTwo, limit);
  if (/[。！？!?…]$/u.test(limited)) return limited;
  return `${limited}。`;
}

function hasConstraintLanguage(value: string): boolean {
  return /必须|不要|不能|需要|希望|同时|保持|允许|最多|至少|前提|约束/.test(
    value,
  );
}

function hasQuestionLanguage(value: string): boolean {
  return /[?？]|是否|能不能|是不是|如何|为什么|怎么/.test(value);
}

function hasDirectionLanguage(value: string): boolean {
  return /目标|核心|定位|聚焦|专注|只做|只保留|改为|转向|暂停|不再|这一阶段|这一代|先把|现在先/.test(
    value,
  );
}

function hasValidationLanguage(value: string): boolean {
  return /测试|验证|验收|检查|通过|可验证|指标|标准|对照|复现/.test(value);
}

function isSubstantive(value: string): boolean {
  const compact = value.replace(/\s+/gu, '');
  return (
    compact.length >= 8 &&
    !/^(好的|好|可以|继续|继续推进|收到|明白|嗯好的)[。！!]?$/u.test(compact)
  );
}

function sourceFor(index: number): string {
  return `P${String(index + 1).padStart(2, '0')}`;
}

function findingsFor(
  prompts: AgentPrompt[],
  predicate: (value: string) => boolean,
): LocalBriefFinding[] {
  const seen = new Set<string>();
  return prompts
    .map((prompt, index) => ({ prompt, index }))
    .filter(({ prompt }) => predicate(prompt.text))
    .filter(({ prompt }) => {
      if (seen.has(prompt.text)) return false;
      seen.add(prompt.text);
      return true;
    })
    .slice(-3)
    .map(({ prompt, index }) => ({
      text: shortened(prompt.text, 150),
      source: sourceFor(index),
    }));
}

function taskSummaryFor(prompts: AgentPrompt[]): string {
  const direction = [...prompts]
    .reverse()
    .find((prompt) => hasDirectionLanguage(prompt.text));
  const origin = prompts.find((prompt) => isSubstantive(prompt.text));
  const candidate = direction ?? origin ?? prompts.at(-1);
  if (!candidate) return '还没有足够的 Prompt 来判断这个任务。';
  return limitToTwoSentences(candidate.text, 170);
}

function challengeSummaryFor(
  session: AgentSession,
  constraints: LocalBriefFinding[],
  unresolved: LocalBriefFinding[],
): string {
  const sentences: string[] = [];
  if (session.state === 'failed') {
    sentences.push('当前最直接的挑战是定位本轮失败点，并确认哪些结果仍然有效。');
  }

  const constraint = constraints.at(-1)?.text;
  if (constraint) {
    sentences.push(`关键约束是：${withoutTerminalPunctuation(constraint)}。`);
  }

  const question = unresolved
    .map((item) => item.text)
    .reverse()
    .find((text) => text !== constraint);
  if (question && sentences.length < 2) {
    sentences.push(`仍待确认：${withoutTerminalPunctuation(question)}。`);
  }

  if (!sentences.length) {
    sentences.push(
      '最近输入没有明确标出阻塞点；执行时仍需验证关键假设和最终结果。',
    );
  }
  return limitToTwoSentences(sentences.join(''), 190);
}

function nextStepSummaryFor(
  session: AgentSession,
  prompts: AgentPrompt[],
): string {
  if (session.state === 'needs_you') {
    return '先处理当前需要确认的决定，再让 Agent 继续执行。';
  }
  if (session.state === 'failed') {
    return '先定位失败发生在哪一步，再用最小改动恢复并重新验证。';
  }
  if (session.state === 'interrupted') {
    return '先确认中断原因和已保留的结果，再决定恢复还是改换方向。';
  }

  const validation = [...prompts]
    .reverse()
    .find((prompt) => hasValidationLanguage(prompt.text));
  if (
    ['turn_finished', 'subtask_completed', 'completed'].includes(session.state)
  ) {
    if (validation) {
      return limitToTwoSentences(
        `先按最近的验证要求复核结果：${withoutTerminalPunctuation(
          validation.text,
        )}。确认后只推进最值得做的一步。`,
        190,
      );
    }
    return '先快速复核本轮结果，再选择最值得推进的一步。';
  }
  if (
    ['background_ended', 'session_ended'].includes(session.state)
  ) {
    return '先确认会话为何结束，再决定是否开启新回合继续。';
  }
  return '让 Agent 完成当前回合，并检查结果是否满足最近的约束。';
}

function suggestedPromptFor(
  session: AgentSession,
  chronological: AgentPrompt[],
  latest: string,
  constraints: LocalBriefFinding[],
  unresolved: LocalBriefFinding[],
): string {
  if (!latest) return '这个 CLI 还没有同步可供整理的用户指令。';
  const context = `请基于本会话最近 ${chronological.length} 条要求继续推进，并以这条最新方向为准：“${shortened(
    latest,
    360,
  )}”。`;
  const guardrail = constraints.length
    ? `先核对最近明确的 ${constraints.length} 项约束，不要悄悄放宽。`
    : '如果发现必要约束不明确，请先指出，不要自行补充关键假设。';
  const question = unresolved.at(-1)
    ? `仍待确认的问题是：“${shortened(unresolved.at(-1)?.text ?? '', 180)}”。`
    : '';

  if (session.state === 'failed') {
    return `${context}${guardrail}先解释本轮失败发生在哪一步、哪些结果仍然有效，再给出最小恢复方案；${question}不要自动执行不可逆操作。`;
  }
  if (
    ['turn_finished', 'subtask_completed', 'completed'].includes(session.state)
  ) {
    return `${context}${guardrail}先用三点说明已经完成、已经验证和仍未完成的内容；${question}然后只推进最值得做的下一步，并给出可验证结果。`;
  }
  return `${context}${guardrail}${question}完成当前回合时，请明确列出已完成、验证结果和最值得做的下一步，不要自动替我做不可逆决定。`;
}

export function buildLocalBrief(
  session: AgentSession,
  now = Date.now(),
): LocalIntentBrief {
  const cutoff = now - 24 * 60 * 60 * 1000;
  const chronological = [...session.prompts]
    .sort(
      (left, right) =>
        new Date(left.captured_at).getTime() -
        new Date(right.captured_at).getTime(),
    )
    .filter((prompt) => {
      const capturedAt = new Date(prompt.captured_at).getTime();
      return Number.isNaN(capturedAt) || capturedAt >= cutoff;
    })
    .slice(-10);
  const latest = chronological.at(-1)?.text ?? '';
  const constraints = findingsFor(chronological, hasConstraintLanguage);
  const unresolved = findingsFor(chronological, hasQuestionLanguage);

  return {
    challengeSummary: challengeSummaryFor(
      session,
      constraints,
      unresolved,
    ),
    chronological,
    latest,
    nextStepSummary: nextStepSummaryFor(session, chronological),
    suggestedPrompt: suggestedPromptFor(
      session,
      chronological,
      latest,
      constraints,
      unresolved,
    ),
    taskSummary: taskSummaryFor(chronological),
  };
}

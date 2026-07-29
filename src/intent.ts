import type { AgentPrompt, AgentSession } from './types';

export interface LocalIntentBrief {
  chronological: AgentPrompt[];
  constraints: LocalBriefFinding[];
  decisions: LocalBriefFinding[];
  latest: string;
  latestSource: string;
  unresolved: LocalBriefFinding[];
  suggestedPrompt: string;
}

export interface LocalBriefFinding {
  text: string;
  source: string;
}

function shortened(value: string, limit = 220): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trim()}…`;
}

function hasConstraintLanguage(value: string): boolean {
  return /必须|不要|不能|需要|希望|同时|保持|允许|最多|至少|前提|约束/.test(
    value,
  );
}

function hasQuestionLanguage(value: string): boolean {
  return /[?？]|是否|能不能|是不是|如何|为什么|怎么/.test(value);
}

function hasDecisionLanguage(value: string): boolean {
  return /决定|选择|采用|改为|保留|确定|优先|先做|暂定|统一/.test(value);
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
      source: `P${String(index + 1).padStart(2, '0')}`,
    }));
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
  const latestPrompt = chronological.at(-1);
  const latest = latestPrompt?.text ?? '';
  const latestSource = latestPrompt
    ? `P${String(chronological.length).padStart(2, '0')}`
    : '';
  const constraints = findingsFor(chronological, hasConstraintLanguage);
  const unresolved = findingsFor(chronological, hasQuestionLanguage);
  const decisions = findingsFor(chronological, hasDecisionLanguage);
  const suggestedPrompt = latest
    ? `请基于本会话最近 ${chronological.length} 条要求继续推进。先用三点复述你理解的当前目标、新增约束和仍待决定的问题；确认没有遗漏后，再围绕这条最新要求执行：“${shortened(
        latest,
        420,
      )}”。完成时请给出可验证结果，不要自动替我做不可逆决定。`
    : '这个 CLI 还没有同步可供整理的用户指令。';

  return {
    chronological,
    constraints,
    decisions,
    latest,
    latestSource,
    unresolved,
    suggestedPrompt,
  };
}

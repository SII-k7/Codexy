const MAX_ANALYSIS_CHARACTERS = 12_000;
const MAX_HEADLINE_CHARACTERS = 112;
const MAX_HIGHLIGHT_CHARACTERS = 190;
const MAX_HIGHLIGHTS = 4;

const OUTCOME_PATTERN =
  /完成|实现|新增|加入|修复|更新|调整|改为|已将|已把|通过|done|implemented|fixed|updated|added/i;
const VERIFICATION_PATTERN =
  /测试|验证|检查|构建|编译|通过|失败|test|verify|check|build|typecheck|lint|pass|fail/i;
const ATTENTION_PATTERN =
  /注意|风险|限制|尚未|不能|无法|失败|阻塞|需要你|需确认|可能|warning|risk|blocked|failed|cannot/i;
const NEXT_PATTERN =
  /下一步|接下来|建议|可以继续|之后|请你|需要你|next|recommend|follow.?up/i;

function clampText(value, maximum) {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

export function sanitizeAgentReply(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, '\n[代码片段已省略]\n')
    .replace(/^(?: {4}|\t).+$/gm, '[代码行已省略]')
    .replace(
      /^\s*(?:(?:async\s+)?function|class|interface|type|(?:const|let|var)\s+|import\s+|export\s+|(?:async\s+)?def\s+|from\s+\S+\s+import\s+|#include\b).+$/gim,
      '[代码行已省略]',
    )
    .replace(/!\[[^\]]*]\([^)]*\)/g, '[图片已省略]')
    .replace(/\[([^\]]+)]\((?:https?|file):[^)]+\)/gi, '$1')
    .replace(
      /\b(?:bearer\s+)?(?:sk-[a-z0-9_-]{12,}|(?:[a-z0-9_]*(?:api[_-]?key|token|secret|password)[a-z0-9_]*)\s*[:=]\s*\S+|(?:gh[oprsu]|xox[baprs])-[a-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|eyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{8,})/gi,
      '[敏感信息已隐藏]',
    )
    .replace(/\bhttps?:\/\/\S+/gi, '[链接]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[邮箱]')
    .replace(
      /(?<!\w)[A-Za-z]:[\\/](?:[^\s<>:"|?*,，。、；;\[\](){}]+[\\/])*[^\s<>:"|?*,，。、；;\[\](){}]*/g,
      '[本地路径]',
    )
    .replace(
      /(?<!\w)\/(?:[^/\s,，。、；;\[\](){}]+\/)+[^/\s,，。、；;\[\](){}]*/g,
      '[本地路径]',
    )
    .replace(
      /(?<![\w:/])(?:\.{1,2}[\\/])?(?:[a-z0-9_.-]+[\\/])+(?:[a-z0-9_.-]+\.[a-z0-9]{1,10})(?![\w/\\])/gi,
      '[相对路径]',
    )
    .replace(/`[^`\n]{1,240}`/g, '[内联代码已省略]')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
      character === '\n' || character === '\t' ? character : ' ',
    )
    .slice(0, MAX_ANALYSIS_CHARACTERS)
    .trim();
}

function summaryUnits(text) {
  const units = [];
  for (const rawLine of text.split(/\n+/)) {
    const line = rawLine
      .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)、]\s*)/, '')
      .replace(/\*\*|__/g, '')
      .replace(/^\s*\|?[-:|\s]{3,}\|?\s*$/, '')
      .trim();
    if (!line || /^\[(?:代码片段|图片)已省略]$/.test(line)) continue;
    const sentences =
      line.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [line];
    for (const sentence of sentences) {
      const cleaned = clampText(
        sentence.replace(/^[·•]\s*/, ''),
        MAX_HIGHLIGHT_CHARACTERS,
      );
      if (cleaned.length < 6) continue;
      if (
        units.some(
          (existing) =>
            existing.toLocaleLowerCase() ===
            cleaned.toLocaleLowerCase(),
        )
      ) {
        continue;
      }
      units.push(cleaned);
      if (units.length >= 24) return units;
    }
  }
  return units;
}

function classifiedHighlight(unit) {
  if (ATTENTION_PATTERN.test(unit)) {
    return { kind: 'attention', label: '注意', text: unit };
  }
  if (NEXT_PATTERN.test(unit)) {
    return { kind: 'next', label: '下一步', text: unit };
  }
  if (VERIFICATION_PATTERN.test(unit)) {
    return { kind: 'verification', label: '验证', text: unit };
  }
  if (OUTCOME_PATTERN.test(unit)) {
    return { kind: 'outcome', label: '完成', text: unit };
  }
  return { kind: 'detail', label: '要点', text: unit };
}

function pickHighlights(units, headline) {
  const candidates = units
    .filter((unit) => unit !== headline)
    .map(classifiedHighlight);
  const selected = [];
  for (const kind of [
    'outcome',
    'verification',
    'attention',
    'next',
    'detail',
  ]) {
    const candidate = candidates.find(
      (item) =>
        item.kind === kind &&
        !selected.some((selectedItem) => selectedItem.text === item.text),
    );
    if (candidate) selected.push(candidate);
    if (selected.length >= MAX_HIGHLIGHTS) break;
  }
  for (const candidate of candidates) {
    if (selected.length >= MAX_HIGHLIGHTS) break;
    if (!selected.some((item) => item.text === candidate.text)) {
      selected.push(candidate);
    }
  }
  return selected;
}

function publicTimestamp(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function unavailableSummary(sessionRef, thread, reason) {
  return {
    available: false,
    session_ref: sessionRef,
    current_turn_active: thread?.status?.type === 'active',
    reason,
    turn_status: null,
    completed_at: null,
    headline: null,
    highlights: [],
    summary_method: 'local_extract',
    source_characters: 0,
    source_truncated: false,
    raw_response_exposed: false,
    persisted: false,
    generated_at: new Date().toISOString(),
  };
}

export function summarizeLatestAgentReply(sessionRef, thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  let selectedTurn = null;
  let selectedText = '';

  for (const turn of [...turns].reverse()) {
    if (turn?.status === 'inProgress') continue;
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const messages = items.filter(
      (item) =>
        item?.type === 'agentMessage' &&
        typeof item.text === 'string' &&
        item.text.trim(),
    );
    const preferred =
      [...messages]
        .reverse()
        .find((item) => item.phase === 'final_answer') ??
      [...messages].reverse().find((item) => item.phase !== 'commentary') ??
      messages.at(-1);
    const errorText =
      turn?.status === 'failed' && typeof turn?.error?.message === 'string'
        ? `本轮运行失败：${turn.error.message}`
        : '';
    const text = preferred?.text || errorText;
    if (!text) continue;
    selectedTurn = turn;
    selectedText = text;
    break;
  }

  if (!selectedTurn || !selectedText) {
    return unavailableSummary(sessionRef, thread, 'no_final_reply');
  }

  const sanitized = sanitizeAgentReply(selectedText);
  const units = summaryUnits(sanitized);
  if (!units.length) {
    return unavailableSummary(sessionRef, thread, 'reply_removed_by_privacy_filter');
  }
  const primary =
    units.find((unit) => OUTCOME_PATTERN.test(unit)) ?? units[0];
  const headline = clampText(primary, MAX_HEADLINE_CHARACTERS);
  return {
    available: true,
    session_ref: sessionRef,
    current_turn_active: thread?.status?.type === 'active',
    reason: null,
    turn_status: String(selectedTurn.status ?? 'completed'),
    completed_at: publicTimestamp(selectedTurn.completedAt),
    headline,
    highlights: pickHighlights(units, primary),
    summary_method: 'local_extract',
    source_characters: selectedText.length,
    source_truncated:
      selectedText.length > MAX_ANALYSIS_CHARACTERS,
    raw_response_exposed: false,
    persisted: false,
    generated_at: new Date().toISOString(),
  };
}

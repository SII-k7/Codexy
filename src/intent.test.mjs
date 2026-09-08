import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLocalBrief } from './intent.ts';

const NOW = new Date('2026-07-30T08:00:00.000Z');

function prompt(index, text) {
  return {
    prompt_id: `prompt-${index}`,
    captured_at: new Date(NOW.getTime() - (8 - index) * 60_000).toISOString(),
    text,
  };
}

function sentenceCount(value) {
  return (value.match(/[。！？!?]/g) ?? []).length;
}

test('compresses recent prompts into three two-sentence summaries', () => {
  const brief = buildLocalBrief(
    {
      session_ref: 'sha256:1111222233334444',
      source: 'codex',
      project_alias: 'codexy',
      state: 'turn_finished',
      summary: 'done',
      updated_at: NOW.toISOString(),
      prompt_count: 6,
      prompts: [
        prompt(1, '先做一个可以查看 Codex 状态的手机原型。'),
        prompt(2, '所有 Prompt 必须先在电脑端脱敏。'),
        prompt(3, '是否可以同时管理多个 CLI？'),
        prompt(4, '现在先聚焦多 Agent 注意力控制台，不做商业化。'),
        prompt(5, '完成后需要通过类型检查和手机端验证。'),
        prompt(6, '继续推进实现。'),
      ],
    },
    NOW.getTime(),
  );

  assert.equal(
    brief.taskSummary,
    '现在先聚焦多 Agent 注意力控制台，不做商业化。',
  );
  assert.match(brief.challengeSummary, /关键约束|仍待确认/);
  assert.match(brief.nextStepSummary, /验证要求|复核结果/);
  assert.equal(sentenceCount(brief.taskSummary) <= 2, true);
  assert.equal(sentenceCount(brief.challengeSummary) <= 2, true);
  assert.equal(sentenceCount(brief.nextStepSummary) <= 2, true);
  assert.match(brief.suggestedPrompt, /已经完成、已经验证和仍未完成/);
});

test('adapts the suggested next prompt when a session failed', () => {
  const brief = buildLocalBrief(
    {
      session_ref: 'sha256:9999000011112222',
      source: 'codex',
      project_alias: 'failed-project',
      state: 'failed',
      summary: 'failed',
      updated_at: NOW.toISOString(),
      prompt_count: 1,
      prompts: [prompt(1, '修复构建问题，但不要改动发布配置。')],
    },
    NOW.getTime(),
  );

  assert.match(brief.suggestedPrompt, /失败发生在哪一步/);
  assert.match(brief.suggestedPrompt, /不要悄悄放宽/);
  assert.match(brief.challengeSummary, /定位本轮失败点/);
  assert.match(brief.nextStepSummary, /最小改动恢复/);
  assert.equal(sentenceCount(brief.challengeSummary) <= 2, true);
  assert.equal(sentenceCount(brief.nextStepSummary) <= 2, true);
});

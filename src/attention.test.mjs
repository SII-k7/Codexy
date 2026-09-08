import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAttentionQueue } from './attention.ts';

const NOW = '2026-07-30T08:00:00.000Z';

function session(sessionRef, state, summary) {
  return {
    session_ref: sessionRef,
    source: 'codex',
    project_alias: sessionRef,
    state,
    summary,
    updated_at: NOW,
    prompts: [],
    prompt_count: 0,
    control_status: 'ready',
  };
}

test('orders human decisions and failures ahead of result review', () => {
  const queue = buildAttentionQueue([
    session('review-project', 'turn_finished', 'finished'),
    session('decision-project', 'needs_you', 'approve this'),
    session('working-project', 'working', 'still working'),
    session('failed-project', 'failed', 'failed'),
  ]);

  assert.deepEqual(
    queue.map((item) => item.sessionRef),
    ['decision-project', 'failed-project', 'review-project'],
  );
  assert.equal(queue[0].urgent, true);
  assert.equal(queue.some((item) => item.sessionRef === 'working-project'), false);
});

test('uses the ephemeral reply summary to explain output and the next move', () => {
  const review = session(
    'review-project',
    'turn_finished',
    'generic lifecycle update',
  );
  const queue = buildAttentionQueue([review], {
    'review-project': {
      available: true,
      session_ref: 'review-project',
      current_turn_active: false,
      reason: null,
      turn_status: 'completed',
      completed_at: NOW,
      headline: '已完成三个界面并通过类型检查。',
      highlights: [
        {
          kind: 'next',
          label: '下一步',
          text: '建议在 iPhone 上验证通知深链。',
        },
      ],
      summary_method: 'local_extract',
      source_characters: 120,
      source_truncated: false,
      raw_response_exposed: false,
      persisted: false,
      generated_at: NOW,
    },
  });

  assert.equal(queue[0].agentUpdate, '已完成三个界面并通过类型检查。');
  assert.equal(queue[0].nextMove, '建议在 iPhone 上验证通知深链。');
  assert.equal(queue[0].canSummarize, true);
  assert.equal(queue[0].summaryAvailable, true);
});

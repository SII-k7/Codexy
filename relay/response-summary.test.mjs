import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeAgentReply,
  summarizeLatestAgentReply,
} from './response-summary.mjs';

const SESSION_REF = 'sha256:eeeeeeeeeeeeeeeeeeeeeeee';

test('builds a structured local summary without exposing reply internals', () => {
  const thread = {
    status: { type: 'idle' },
    turns: [
      {
        id: 'turn-summary-1',
        status: 'completed',
        completedAt: 1_900_000_000,
        items: [
          {
            type: 'agentMessage',
            phase: 'commentary',
            text: 'I am still working.',
          },
          {
            type: 'agentMessage',
            phase: 'final_answer',
            text: [
              '## 完成',
              '- 已新增手机端回复速览卡。',
              '- `npm run check`：26 项测试全部通过。',
              '- 修改位于 C:\\private\\project\\reply.ts，并参考 https://example.test/private。',
              '- 下一步请在 iPhone 上确认信息层级。',
              'token=super-secret-value-123456789',
              '```ts',
              'const privateValue = "do-not-expose";',
              '```',
            ].join('\n'),
          },
        ],
      },
    ],
  };

  const summary = summarizeLatestAgentReply(SESSION_REF, thread);
  const serialized = JSON.stringify(summary);

  assert.equal(summary.available, true);
  assert.equal(summary.session_ref, SESSION_REF);
  assert.equal(summary.turn_status, 'completed');
  assert.equal(summary.current_turn_active, false);
  assert.equal(summary.summary_method, 'local_extract');
  assert.equal(summary.raw_response_exposed, false);
  assert.equal(summary.persisted, false);
  assert.match(summary.headline, /已新增手机端回复速览卡/);
  assert.ok(
    summary.highlights.some(
      (item) => item.kind === 'verification' && /测试全部通过/.test(item.text),
    ),
  );
  assert.ok(
    summary.highlights.some(
      (item) => item.kind === 'next' && /iPhone/.test(item.text),
    ),
  );
  assert.doesNotMatch(serialized, /private\\project|example\.test/);
  assert.doesNotMatch(serialized, /super-secret-value|do-not-expose/);
  assert.doesNotMatch(serialized, /C:\\/);
});

test('shows the latest completed reply while a new turn is active', () => {
  const thread = {
    status: { type: 'active' },
    turns: [
      {
        id: 'turn-complete',
        status: 'completed',
        completedAt: 1_900_000_000,
        items: [
          {
            type: 'agentMessage',
            phase: 'final_answer',
            text: '已完成上一轮界面调整，并通过最小验证。',
          },
        ],
      },
      {
        id: 'turn-active',
        status: 'inProgress',
        completedAt: null,
        items: [
          {
            type: 'agentMessage',
            phase: 'commentary',
            text: '正在处理尚未完成的新任务。',
          },
        ],
      },
    ],
  };

  const summary = summarizeLatestAgentReply(SESSION_REF, thread);

  assert.equal(summary.available, true);
  assert.equal(summary.current_turn_active, true);
  assert.match(summary.headline, /上一轮界面调整/);
  assert.doesNotMatch(JSON.stringify(summary), /尚未完成的新任务/);
});

test('turns a failed turn into a sanitized attention summary', () => {
  const thread = {
    status: { type: 'idle' },
    turns: [
      {
        id: 'turn-failed',
        status: 'failed',
        completedAt: 1_900_000_000,
        error: {
          message:
            '无法读取 C:\\private\\failure.log，secret=hidden-value-123456。',
        },
        items: [],
      },
    ],
  };

  const summary = summarizeLatestAgentReply(SESSION_REF, thread);

  assert.equal(summary.available, true);
  assert.equal(summary.turn_status, 'failed');
  assert.match(summary.headline, /本轮运行失败/);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /private\\failure|hidden-value/,
  );
});

test('returns an explicit empty state when no final reply exists', () => {
  const summary = summarizeLatestAgentReply(SESSION_REF, {
    status: { type: 'active' },
    turns: [
      {
        id: 'turn-active-only',
        status: 'inProgress',
        items: [],
      },
    ],
  });

  assert.equal(summary.available, false);
  assert.equal(summary.reason, 'no_final_reply');
  assert.equal(summary.current_turn_active, true);
  assert.deepEqual(summary.highlights, []);
});

test('sanitizer retains meaning while removing code, links, and paths', () => {
  const sanitized = sanitizeAgentReply(
    [
      '已完成。详情见 /private/repo/file.ts、src/components/Secret.tsx 和 https://example.test。',
      '运行 `npm run secret-check` 后通过。',
      'const privateValue = "do-not-expose";',
      'OPENAI_API_KEY=private-token-value-123456',
      '```js',
      'secret()',
      '```',
    ].join('\n'),
  );

  assert.match(sanitized, /已完成/);
  assert.match(sanitized, /\[本地路径]/);
  assert.match(sanitized, /\[相对路径]/);
  assert.match(sanitized, /\[内联代码已省略]/);
  assert.match(sanitized, /\[链接]/);
  assert.doesNotMatch(
    sanitized,
    /secret\(\)|example\.test|private\/repo|Secret\.tsx|npm run secret|privateValue|private-token-value/,
  );
});

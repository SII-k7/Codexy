import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodexControlBridge,
  sessionRefForThreadId,
} from './codex-control.mjs';

function controlledThread(overrides = {}) {
  return {
    id: '019abcde-0000-7000-8000-000000000001',
    status: { type: 'idle' },
    canAcceptDirectInput: false,
    ...overrides,
  };
}

function modelCatalog() {
  return {
    data: [
      {
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        description: 'Frontier coding model',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
          { reasoningEffort: 'ultra' },
        ],
        defaultReasoningEffort: 'medium',
        isDefault: true,
        hidden: false,
      },
      {
        model: 'hidden-model',
        displayName: 'Hidden',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
        defaultReasoningEffort: 'medium',
        hidden: true,
      },
    ],
    nextCursor: null,
  };
}

function attachControlRpc(
  bridge,
  {
    thread = controlledThread(),
    model = 'gpt-5.6-sol',
    reasoningEffort = 'medium',
  } = {},
) {
  const calls = [];
  const state = { model, reasoningEffort };
  bridge.rpc = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/list') {
        return { data: [thread], nextCursor: null };
      }
      if (method === 'thread/resume') {
        return {
          thread: {
            ...thread,
            status: thread.status,
            canAcceptDirectInput: true,
          },
          model: state.model,
          reasoningEffort: state.reasoningEffort,
          approvalPolicy: 'on-request',
          activePermissionProfile: { id: ':read-only' },
        };
      }
      if (method === 'model/list') return modelCatalog();
      if (method === 'account/rateLimits/read') {
        return {
          rateLimits: {
            primary: {
              usedPercent: 23,
              windowDurationMins: 300,
              resetsAt: 1_900_000_000,
            },
            secondary: null,
          },
        };
      }
      if (method === 'thread/settings/update') {
        state.model = params.model;
        state.reasoningEffort = params.effort;
        return {};
      }
      if (
        method === 'thread/compact/start' ||
        method === 'review/start' ||
        method === 'turn/interrupt'
      ) {
        return {};
      }
      if (method === 'thread/read') {
        return {
          thread: {
            ...thread,
            turns: [{ id: 'turn-active-1', status: 'inProgress' }],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  return { calls, state };
}

test('treats a known thread as ready for lazy resume', () => {
  const bridge = new CodexControlBridge({
    enabled: true,
    spawnServer: false,
  });
  bridge.state = 'ready';
  const thread = controlledThread();
  const sessionRef = sessionRefForThreadId(thread.id);
  bridge.threadIndex.set(sessionRef, thread);

  assert.equal(bridge.statusForSession(sessionRef), 'ready');

  thread.status = { type: 'notLoaded' };
  assert.equal(bridge.statusForSession(sessionRef), 'ready');

  thread.status = { type: 'systemError' };
  assert.equal(bridge.statusForSession(sessionRef), 'observe_only');
});

test('runtime evidence expires and excludes unloaded threads or a disconnected bridge', () => {
  const bridge = new CodexControlBridge({ enabled: true, spawnServer: false });
  bridge.state = 'ready'; bridge.indexUpdatedAt = Date.now();
  const thread = controlledThread({ status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  const ref = sessionRefForThreadId(thread.id); bridge.threadIndex.set(ref, thread);
  assert.equal(bridge.activityForSession(ref).needsInput, true);
  bridge.indexUpdatedAt = Date.now() - 76000; assert.equal(bridge.activityForSession(ref), null);
  bridge.indexUpdatedAt = Date.now(); thread.status = { type: 'notLoaded' }; assert.equal(bridge.activityForSession(ref), null);
  thread.status = { type: 'active' }; bridge.state = 'error'; assert.equal(bridge.activityForSession(ref), null);
});

test('resumes an unloaded thread before starting a queued mobile prompt', async () => {
  const bridge = new CodexControlBridge({
    enabled: true,
    spawnServer: false,
  });
  bridge.state = 'ready';
  const thread = controlledThread({ status: { type: 'notLoaded' } });
  const sessionRef = sessionRefForThreadId(thread.id);
  const methods = [];
  bridge.rpc = {
    async request(method, params) {
      methods.push(method);
      if (method === 'thread/list') {
        return { data: [thread], nextCursor: null };
      }
      if (method === 'thread/resume') {
        assert.equal(params.threadId, thread.id);
        assert.equal(params.excludeTurns, true);
        return {
          thread: {
            ...thread,
            status: { type: 'idle' },
            canAcceptDirectInput: true,
          },
        };
      }
      if (method === 'turn/start') {
        assert.equal(params.threadId, thread.id);
        assert.equal(params.input[0].text, 'Continue from the phone.');
        return { turn: { id: 'turn-mobile-1' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };

  const result = await bridge.dispatch({
    sessionRef,
    commandId: 'mobile-command-1',
    mode: 'queue',
    prompt: 'Continue from the phone.',
    expiresAtMs: Date.now() + 60_000,
  });

  assert.deepEqual(methods, ['thread/list', 'thread/resume', 'turn/start']);
  assert.equal(result.turnId, 'turn-mobile-1');
  assert.equal(
    bridge.threadIndex.get(sessionRef).canAcceptDirectInput,
    true,
  );
});

test('returns a sanitized, dynamic control snapshot without local identifiers', async () => {
  const bridge = new CodexControlBridge({
    enabled: true,
    spawnServer: false,
  });
  bridge.state = 'ready';
  const thread = controlledThread({
    cwd: 'F:\\private\\project',
  });
  const sessionRef = sessionRefForThreadId(thread.id);
  attachControlRpc(bridge, { thread });

  const snapshot = await bridge.getSessionControl(sessionRef);

  assert.equal(snapshot.session_ref, sessionRef);
  assert.equal(snapshot.model, 'gpt-5.6-sol');
  assert.equal(snapshot.reasoning_effort, 'medium');
  assert.equal(snapshot.approval_policy, 'on-request');
  assert.equal(snapshot.permission_profile, 'read-only');
  assert.deepEqual(snapshot.models, [
    {
      id: 'gpt-5.6-sol',
      display_name: 'GPT-5.6 Sol',
      description: 'Frontier coding model',
      is_default: true,
      supported_efforts: ['low', 'medium', 'high', 'ultra'],
      default_effort: 'medium',
    },
  ]);
  assert.equal(snapshot.rate_limit.primary.used_percent, 23);
  assert.equal(snapshot.settings_apply_to, 'subsequent_turns');
  assert.equal(snapshot.thread_id, undefined);
  assert.equal(snapshot.cwd, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|019abcde/i);
});

test('reads the latest reply summary without resuming or exposing the thread', async () => {
  const bridge = new CodexControlBridge({
    enabled: true,
    spawnServer: false,
  });
  bridge.state = 'ready';
  const thread = controlledThread();
  const sessionRef = sessionRefForThreadId(thread.id);
  const methods = [];
  bridge.rpc = {
    async request(method) {
      methods.push(method);
      if (method === 'thread/list') {
        return { data: [thread], nextCursor: null };
      }
      if (method === 'thread/read') {
        return {
          thread: {
            ...thread,
            turns: [
              {
                id: 'turn-reply-1',
                status: 'completed',
                completedAt: 1_900_000_000,
                items: [
                  {
                    type: 'agentMessage',
                    phase: 'final_answer',
                    text: '已完成回复摘要，并通过测试。',
                  },
                ],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };

  const summary = await bridge.getSessionResponseSummary(sessionRef);

  assert.equal(summary.available, true);
  assert.match(summary.headline, /回复摘要/);
  assert.deepEqual(methods, ['thread/list', 'thread/read']);
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(thread.id));
});

test('updates the selected model and effort for subsequent turns', async () => {
  const bridge = new CodexControlBridge({
    enabled: true,
    spawnServer: false,
  });
  bridge.state = 'ready';
  const thread = controlledThread();
  const sessionRef = sessionRefForThreadId(thread.id);
  const { calls } = attachControlRpc(bridge, { thread });

  const snapshot = await bridge.updateSessionSettings(sessionRef, {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'ultra',
  });

  const update = calls.find(
    ({ method }) => method === 'thread/settings/update',
  );
  assert.deepEqual(update.params, {
    threadId: thread.id,
    model: 'gpt-5.6-sol',
    effort: 'ultra',
  });
  assert.equal(snapshot.reasoning_effort, 'ultra');
  assert.equal(snapshot.settings_apply_to, 'subsequent_turns');
});

test('maps compact and review actions to native App Server methods', async () => {
  const bridge = new CodexControlBridge({
    enabled: true,
    spawnServer: false,
  });
  bridge.state = 'ready';
  const thread = controlledThread();
  const sessionRef = sessionRefForThreadId(thread.id);
  const { calls } = attachControlRpc(bridge, { thread });

  const compact = await bridge.runSessionAction(sessionRef, 'compact');
  const review = await bridge.runSessionAction(sessionRef, 'review');

  assert.equal(compact.accepted, true);
  assert.equal(review.accepted, true);
  assert.deepEqual(
    calls.find(({ method }) => method === 'thread/compact/start').params,
    { threadId: thread.id },
  );
  assert.deepEqual(
    calls.find(({ method }) => method === 'review/start').params,
    {
      threadId: thread.id,
      target: { type: 'uncommittedChanges' },
      delivery: 'inline',
    },
  );
});

test('interrupts only the currently active turn', async () => {
  const bridge = new CodexControlBridge({
    enabled: true,
    spawnServer: false,
  });
  bridge.state = 'ready';
  const thread = controlledThread({ status: { type: 'active' } });
  const sessionRef = sessionRefForThreadId(thread.id);
  const { calls } = attachControlRpc(bridge, { thread });

  const interrupted = await bridge.runSessionAction(
    sessionRef,
    'interrupt',
  );

  assert.equal(interrupted.accepted, true);
  assert.deepEqual(
    calls.find(({ method }) => method === 'turn/interrupt').params,
    {
      threadId: thread.id,
      turnId: 'turn-active-1',
    },
  );
});

test('does not start a turn when resume cannot claim direct input', async () => {
  const bridge = new CodexControlBridge({
    enabled: true,
    spawnServer: false,
  });
  bridge.state = 'ready';
  const thread = controlledThread();
  const sessionRef = sessionRefForThreadId(thread.id);
  bridge.rpc = {
    async request(method) {
      if (method === 'thread/list') {
        return { data: [thread], nextCursor: null };
      }
      if (method === 'thread/resume') {
        return { thread };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };

  await assert.rejects(
    bridge.dispatch({
      sessionRef,
      commandId: 'mobile-command-2',
      mode: 'queue',
      prompt: 'This must not be sent.',
      expiresAtMs: Date.now() + 60_000,
    }),
    (error) => error?.code === 'session_observe_only',
  );
});

test('paginated thread history falls back to bounded recent turns in chronological order', async () => {
  const bridge = new CodexControlBridge({ enabled: true, spawnServer: false });
  const calls = [];
  const newestFirst = [{ id: 'active', status: 'inProgress', items: [] }, { id: 'previous', status: 'completed', items: [] }];
  bridge.rpc = { async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/read' && params.includeTurns) throw new Error('paginated threads do not support thread/read(includeTurns=true)');
    if (method === 'thread/read') return { thread: { id: 'fixture', status: { type: 'active' } } };
    if (method === 'thread/turns/list') return { data: newestFirst, nextCursor: 'older' };
    throw new Error('Unexpected method');
  } };
  const thread = await bridge.readThread('fixture', true);
  assert.deepEqual(thread.turns.map(t => t.id), ['previous', 'active']);
  assert.equal(thread.status.type, 'active');
  assert.equal(newestFirst[0].id, 'active');
  assert.deepEqual(calls[2], { method: 'thread/turns/list', params: { threadId: 'fixture', limit: 10, sortDirection: 'desc', itemsView: 'full' } });
  assert.equal(calls.length, 3);
});

test('thread read failures unrelated to pagination are preserved without extra history reads', async () => {
  const bridge = new CodexControlBridge({ enabled: true, spawnServer: false });
  let calls = 0;
  bridge.rpc = { async request() { calls++; throw new Error('connection unavailable'); } };
  await assert.rejects(bridge.readThread('fixture', true), /connection unavailable/);
  assert.equal(calls, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RemoteCommandError,
  createRemoteCommandManager,
} from './remote-commands.mjs';

test('Steer bypasses a Queue waiting for the active turn', async () => {
  const gate = deferred(); const started = [];
  const manager = createRemoteCommandManager({ dispatch: async (command, setStatus) => {
    started.push(command.mode);
    if (command.mode === 'queue') { setStatus('waiting', 'waiting'); await gate.promise; }
    return { turnId: 'active' };
  } });
  manager.enqueue(input('queue-command'));
  const steer = manager.enqueue({ ...input('steer-command'), mode: 'steer' });
  await nextTurn();
  assert.deepEqual(started, ['queue', 'steer']);
  assert.equal(manager.get('device-test', steer.command_id).status, 'sent');
  gate.resolve(); await nextTurn(); manager.close();
});

test('different phones serialize Queue commands for the same desktop session', async () => {
  const gate = deferred(); const started = [];
  const manager = createRemoteCommandManager({ dispatch: async (command) => { started.push(command.deviceId); if (started.length === 1) await gate.promise; } });
  manager.enqueue(input('one-command'));
  manager.enqueue({ ...input('two-command'), deviceId: 'other-phone' });
  await nextTurn(); assert.deepEqual(started, ['device-test']);
  gate.resolve(); await nextTurn(); assert.deepEqual(started, ['device-test', 'other-phone']); manager.close();
});

test('idempotency replays a receipt and rejects changed content or target', async () => {
  const manager = createRemoteCommandManager({ dispatch: async () => ({ turnId: 'one' }) });
  const first = manager.enqueue(input('same-key')); await nextTurn();
  assert.equal(manager.enqueue(input('same-key')).command_id, first.command_id);
  assert.throws(() => manager.enqueue(input('same-key', 'different')), { code: 'idempotency_conflict' });
  assert.throws(() => manager.findExisting({ ...input('same-key'), sessionRef: 'another' }), { code: 'idempotency_conflict' });
  manager.close();
});

test('receipt arriving after TTL remains sent and uncertain transport is not labeled failed', async () => {
  let clock = 0; const gate = deferred();
  const manager = createRemoteCommandManager({ now: () => clock, ttlMs: 100,
    dispatch: async (command) => { if (command.prompt === 'unknown') throw new RemoteCommandError('delivery_unknown', 'check session'); await gate.promise; return { turnId: 'accepted' }; } });
  const command = manager.enqueue(input('slow-ack')); await nextTurn(); clock = 101;
  gate.resolve(); await nextTurn();
  assert.equal(manager.get('device-test', command.command_id).status, 'sent');
  const unknown = manager.enqueue(input('unknown-key', 'unknown')); await nextTurn();
  assert.equal(manager.get('device-test', unknown.command_id).status, 'unknown'); manager.close();
});

test('waiting and queued prompts expire even when an earlier dispatch is blocked', async () => {
  let clock = 0; const gate = deferred(); let observed;
  const manager = createRemoteCommandManager({ now: () => clock, ttlMs: 100, dispatch: async (command, setStatus) => { observed = command; setStatus('waiting', 'busy'); await gate.promise; } });
  manager.enqueue(input('first-expire')); const second = manager.enqueue(input('second-expire'));
  await nextTurn(); clock = 101; manager.list('device-test');
  assert.equal(observed.prompt, ''); assert.equal(observed.status, 'expired');
  assert.equal(manager.get('device-test', second.command_id).status, 'expired');
  gate.resolve(); await nextTurn(); manager.close();
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function input(idempotencyKey, prompt = idempotencyKey) {
  return {
    deviceId: 'device-test',
    idempotencyKey,
    mode: 'queue',
    prompt,
    sessionRef: 'sha256:111122223333444455556666',
  };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('serializes remote prompts for the same Codex session', async () => {
  const gates = [deferred(), deferred()];
  const started = [];
  const manager = createRemoteCommandManager({
    dispatch: async (command) => {
      const index = started.length;
      started.push(command.prompt);
      await gates[index].promise;
      return { turnId: `turn-${index + 1}` };
    },
  });

  const first = manager.enqueue(input('first-command', 'first prompt'));
  const second = manager.enqueue(input('second-command', 'second prompt'));
  await nextTurn();
  assert.deepEqual(started, ['first prompt']);
  assert.equal(manager.get('device-test', second.command_id).status, 'queued');

  gates[0].resolve();
  await nextTurn();
  assert.deepEqual(started, ['first prompt', 'second prompt']);
  assert.equal(manager.get('device-test', first.command_id).status, 'sent');

  gates[1].resolve();
  await nextTurn();
  assert.equal(manager.get('device-test', second.command_id).status, 'sent');
  manager.close();
});

test('cancels a waiting prompt and erases it before dispatch can continue', async () => {
  const release = deferred();
  let observedCommand;
  const manager = createRemoteCommandManager({
    dispatch: async (command, setStatus) => {
      observedCommand = command;
      setStatus('waiting', 'test waiting');
      await release.promise;
      if (command.status === 'canceled') {
        throw new RemoteCommandError(
          'command_canceled',
          'command was canceled',
        );
      }
      return { turnId: 'unexpected-turn' };
    },
  });

  const created = manager.enqueue(input('cancel-command', 'private prompt'));
  await nextTurn();
  assert.equal(manager.get('device-test', created.command_id).status, 'waiting');

  const canceled = manager.cancel('device-test', created.command_id);
  assert.equal(canceled.status, 'canceled');
  assert.equal(observedCommand.status, 'canceled');
  assert.equal(observedCommand.prompt, '');

  release.resolve();
  await nextTurn();
  assert.equal(
    manager.get('device-test', created.command_id).status,
    'canceled',
  );
  manager.close();
});

test('refuses a misleading cancellation after dispatch has begun', async () => {
  const release = deferred();
  const manager = createRemoteCommandManager({
    dispatch: async (_command, setStatus) => {
      setStatus('dispatching', 'test dispatching');
      await release.promise;
      return { turnId: 'turn-dispatching' };
    },
  });

  const created = manager.enqueue(input('dispatch-command'));
  await nextTurn();
  assert.throws(
    () => manager.cancel('device-test', created.command_id),
    (error) =>
      error instanceof RemoteCommandError &&
      error.code === 'command_already_dispatching',
  );

  release.resolve();
  await nextTurn();
  manager.close();
});

test('removing a device erases its in-memory commands', async () => {
  const release = deferred();
  const manager = createRemoteCommandManager({
    dispatch: async (_command, setStatus) => {
      setStatus('waiting', 'test waiting');
      await release.promise;
      return { turnId: 'turn-removed-device' };
    },
  });

  const created = manager.enqueue(input('remove-device-command'));
  await nextTurn();
  manager.removeDevice('device-test');
  assert.equal(manager.get('device-test', created.command_id), null);
  assert.deepEqual(manager.list('device-test'), []);

  release.resolve();
  await nextTurn();
  manager.close();
});

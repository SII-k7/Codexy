import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RemoteCommandError,
  createRemoteCommandManager,
} from './remote-commands.mjs';

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

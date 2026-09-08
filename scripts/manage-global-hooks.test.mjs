import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  installHooks,
  isCodexyHook,
  mergeCodexyEntries,
  removeHooks,
} from './manage-global-hooks.mjs';

const codexyHook = {
  type: 'command',
  command:
    '/bin/sh -c \'exec "$HOME/.codex/codexy-hooks/notify_mobile.sh"\'',
};
const otherHook = {
  type: 'command',
  command: '/usr/local/bin/my-own-hook',
};

test('Codexy hooks are recognized without matching unrelated hooks', () => {
  assert.equal(isCodexyHook(codexyHook), true);
  assert.equal(isCodexyHook(otherHook), false);
});

test('the shipped hook bundle contains Unix and Windows commands', () => {
  const scriptsDirectory = fileURLToPath(new URL('.', import.meta.url));
  const source = JSON.parse(
    readFileSync(
      join(scriptsDirectory, 'global-codex-hooks', 'hooks.json'),
      'utf8',
    ),
  );
  const hooks = Object.values(source.hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks),
  );
  assert.ok(hooks.length > 0);
  for (const hook of hooks) {
    assert.equal(isCodexyHook(hook), true);
    assert.match(hook.command, /^\/bin\/sh /);
    assert.match(hook.commandWindows, /cmd\.exe/i);
  }
});

test('hook merge replaces only Codexy-owned entries', () => {
  const target = {
    description: 'personal hooks',
    hooks: {
      Stop: [{ hooks: [otherHook, codexyHook] }],
    },
  };
  const source = {
    hooks: {
      Stop: [{ hooks: [{ ...codexyHook, timeout: 5 }] }],
      SessionEnd: [{ hooks: [codexyHook] }],
    },
  };
  const result = mergeCodexyEntries(target, source);
  assert.equal(result.replaced, 1);
  assert.equal(result.added, 2);
  assert.equal(result.config.description, 'personal hooks');
  assert.deepEqual(result.config.hooks.Stop[0].hooks, [otherHook]);
  assert.equal(result.config.hooks.Stop.length, 2);
});

test('install and remove preserve non-Codexy hooks', () => {
  const root = mkdtempSync(join(tmpdir(), 'codexy-hooks-'));
  const source = join(root, 'source');
  const codexHome = join(root, '.codex');
  const fakeNode = join(root, 'node');
  mkdirSync(source, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(fakeNode, '#!/bin/sh\n', { mode: 0o700 });
  chmodSync(fakeNode, 0o700);

  const files = [
    'capture_prompt.mjs',
    'capture_prompt.sh',
    'hook_common.mjs',
    'notify_mobile.mjs',
    'notify_mobile.sh',
    'README.md',
  ];
  for (const file of files) writeFileSync(join(source, file), `${file}\n`);
  writeFileSync(
    join(source, 'hooks.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [codexyHook] }] } }),
  );
  writeFileSync(
    join(codexHome, 'hooks.json'),
    JSON.stringify({
      description: 'personal hooks',
      hooks: { Stop: [{ hooks: [otherHook] }] },
    }),
  );

  installHooks({ sourceDirectory: source, codexHome, nodePath: fakeNode });
  const installed = JSON.parse(
    readFileSync(join(codexHome, 'hooks.json'), 'utf8'),
  );
  assert.equal(installed.hooks.Stop.length, 2);
  assert.equal(
    readFileSync(join(codexHome, 'codexy-hooks', 'node-path'), 'utf8').trim(),
    fakeNode,
  );

  removeHooks({ codexHome });
  const remaining = JSON.parse(
    readFileSync(join(codexHome, 'hooks.json'), 'utf8'),
  );
  assert.deepEqual(remaining.hooks.Stop[0].hooks, [otherHook]);
  assert.equal(existsSync(join(codexHome, 'codexy-hooks')), false);
});

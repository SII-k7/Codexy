import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const hooksRoot = resolve(
  import.meta.dirname,
  '..',
  'scripts',
  'global-codex-hooks',
);

function runHook(script, input, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve(hooksRoot, script)], {
      env: { ...process.env, ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', rejectRun);
    child.once('exit', (code) => resolveRun({ code, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function withHookRelay(action) {
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      path: request.url,
    });
    response.writeHead(202, { 'Content-Type': 'application/json' });
    response.end('{"accepted":true}');
  });
  await new Promise((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen),
  );
  try {
    return await action({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      received,
    });
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) =>
        error ? rejectClose(error) : resolveClose(),
      ),
    );
  }
}

test('Node prompt hook uses the active device and sanitizes local input', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codexy-hook-test-'));
  try {
    const stateFile = join(directory, 'state.json');
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        activeDeviceId: 'active-phone',
        devices: [
          {
            deviceId: 'old-phone',
            hookToken: 'old-token',
          },
          {
            deviceId: 'active-phone',
            hookToken: 'active-token',
          },
        ],
      }),
      'utf8',
    );
    await withHookRelay(async ({ baseUrl, received }) => {
      const result = await runHook(
        'capture_prompt.mjs',
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'thread-private-1',
          turn_id: 'turn-private-1',
          cwd: 'C:\\private\\research-project',
          prompt:
            '请检查 C:\\private\\plan.md，token=super-secret-value，并参考 https://example.com。',
        },
        {
          CODEXY_PROMPT_RELAY_URL: `${baseUrl}/v1/prompts`,
          CODEXY_RELAY_STATE_FILE: stateFile,
        },
      );
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      assert.equal(received.length, 1);
      assert.equal(received[0].authorization, 'Bearer active-token');
      assert.equal(received[0].path, '/v1/prompts');
      assert.match(received[0].body.text, /\[path\]/);
      assert.match(received[0].body.text, /\[redacted\]/);
      assert.match(received[0].body.text, /\[link\]/);
      assert.doesNotMatch(received[0].body.text, /super-secret-value/);
      assert.equal(received[0].body.project_alias, 'research-project');
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('Node notification hook sends only a generic lifecycle event', async () => {
  await withHookRelay(async ({ baseUrl, received }) => {
    const result = await runHook(
      'notify_mobile.mjs',
      {
        hook_event_name: 'PermissionRequest',
        session_id: 'thread-private-2',
        turn_id: 'turn-private-2',
        cwd: 'C:\\private\\agent-project',
        prompt: 'this must not leave the PC',
        tool_input: 'private tool input',
      },
      {
        CODEXY_RELAY_TOKEN: 'explicit-active-token',
        CODEXY_RELAY_URL: `${baseUrl}/v1/events`,
      },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(received.length, 1);
    assert.equal(
      received[0].authorization,
      'Bearer explicit-active-token',
    );
    assert.equal(received[0].body.state, 'needs_you');
    assert.equal(received[0].body.project_alias, 'agent-project');
    assert.equal(received[0].body.prompt, undefined);
    assert.equal(received[0].body.tool_input, undefined);
  });
});

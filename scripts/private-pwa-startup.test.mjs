import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const exitCode of [0, 7]) test(`Windows service survives stderr and preserves child exit ${exitCode}`, { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'codexy-service-'));
  try {
    for (const dir of ['scripts', 'relay', 'web', 'profile']) mkdirSync(join(root, dir));
    writeFileSync(join(root, 'scripts/start-private-pwa.ps1'), readFileSync(new URL('./start-private-pwa.ps1', import.meta.url)));
    writeFileSync(join(root, '.env.local'), `CODEXY_NODE_COMMAND=${process.execPath}\nCODEXY_WEB_ROOT=web\n`);
    writeFileSync(join(root, 'web/index.html'), '<html></html>');
    writeFileSync(join(root, 'relay/server.mjs'), `console.error('recoverable diagnostic'); setTimeout(() => { console.log('still running'); process.exit(${exitCode}); }, 300);`);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/start-private-pwa.ps1')], {
      env: { ...process.env, USERPROFILE: join(root, 'profile') }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, exitCode, result.stderr || result.stdout);
    const logDir = join(root, 'profile/.codex/codexy');
    assert.match(readFileSync(join(logDir, 'relay.log'), 'utf8'), /still running/);
    assert.match(readFileSync(join(logDir, 'relay-stderr.log'), 'utf8'), /recoverable diagnostic/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

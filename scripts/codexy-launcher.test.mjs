import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptsDirectory);

function readProjectFile(...parts) {
  return readFileSync(join(projectRoot, ...parts), 'utf8');
}

test('Windows launcher exposes pair and doctor before preserving Codex arguments', () => {
  const installer = readProjectFile('scripts', 'install-codex-launcher.ps1');
  const launcher = readProjectFile('scripts', 'start-controlled-codex.ps1');

  assert.match(installer, /start-controlled-codex\.ps1/);
  assert.match(installer, /-File "\$launcherScript" %\*/);
  assert.match(installer, /exit \/b %ERRORLEVEL%/);
  assert.match(launcher, /^\s*'pair' \{/m);
  assert.match(launcher, /relay\\claim-pairing\.mjs/);
  assert.match(launcher, /^\s*'doctor' \{/m);
  assert.match(launcher, /diagnose-codexy\.ps1/);
  assert.match(
    launcher,
    /& \$codexCommand --remote \$appServerUrl @launcherArgs/,
  );
});

test('Unix installer writes pair and doctor into the managed launcher', () => {
  const setup = readProjectFile('scripts', 'setup-codexy-unix.sh');
  const launcherStart = setup.indexOf('# Codexy managed launcher');
  const launcherEnd = setup.indexOf('\nEOF', launcherStart);

  assert.notEqual(launcherStart, -1);
  assert.notEqual(launcherEnd, -1);
  const launcher = setup.slice(launcherStart, launcherEnd);
  assert.match(launcher, /^\s*pair\)$/m);
  assert.match(launcher, /relay\/claim-pairing\.mjs/);
  assert.match(launcher, /^\s*doctor\)$/m);
  assert.match(launcher, /diagnose-codexy-unix\.mjs/);
  assert.match(launcher, /exec "\\\$codex_command" --remote/);
  assert.match(launcher, /"\\\$@"/);
});

test('setup completion uses installed recovery commands on both platforms', () => {
  const windowsSetup = readProjectFile('scripts', 'setup-codexy.ps1');
  const unixSetup = readProjectFile('scripts', 'setup-codexy-unix.sh');

  for (const source of [windowsSetup, unixSetup]) {
    assert.match(source, /codexy pair 123456/);
    assert.match(source, /codexy doctor/);
  }
});

test(
  'installed Windows launcher dispatches recovery commands and keeps resume behavior',
  { skip: process.platform !== 'win32' },
  () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'codexy-launcher-'));
    const fakeCodex = join(temporaryDirectory, 'codex.cmd');
    const installer = join(scriptsDirectory, 'install-codex-launcher.ps1');
    const commandShell = process.env.ComSpec ?? 'cmd.exe';
    const environment = {
      ...process.env,
      PATH: `${temporaryDirectory};${process.env.PATH ?? ''}`,
    };

    try {
      writeFileSync(
        fakeCodex,
        '@echo off\r\necho fake-codex %*\r\nexit /b 0\r\n',
        'ascii',
      );
      const installation = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          installer,
        ],
        { encoding: 'utf8', env: environment, timeout: 10_000 },
      );
      assert.equal(
        installation.status,
        0,
        installation.stderr || installation.stdout,
      );

      const pair = spawnSync(
        commandShell,
        ['/d', '/s', '/c', 'codexy.cmd pair'],
        { encoding: 'utf8', env: environment, timeout: 10_000 },
      );
      assert.equal(pair.status, 2, pair.stderr || pair.stdout);
      assert.match(pair.stderr, /Usage: codexy pair <six-digit-code>/);

      const doctor = spawnSync(
        commandShell,
        ['/d', '/s', '/c', 'codexy.cmd doctor unexpected'],
        { encoding: 'utf8', env: environment, timeout: 10_000 },
      );
      assert.equal(doctor.status, 2, doctor.stderr || doctor.stdout);
      assert.match(doctor.stderr, /Usage: codexy doctor/);

      const resume = spawnSync(
        commandShell,
        ['/d', '/s', '/c', 'codexy.cmd resume sample-thread --last'],
        { encoding: 'utf8', env: environment, timeout: 10_000 },
      );
      assert.equal(resume.status, 0, resume.stderr || resume.stdout);
      assert.match(
        resume.stdout,
        /fake-codex --remote ws:\/\/127\.0\.0\.1:4510 resume sample-thread --last/,
      );
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  },
);

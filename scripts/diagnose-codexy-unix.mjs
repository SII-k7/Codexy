import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { isCodexyHook } from './manage-global-hooks.mjs';

function commandVersion(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) return 'unavailable';
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || 'installed';
}

function portStatus(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: '127.0.0.1',
      port,
      timeout: 1_000,
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve('listening on loopback');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('closed');
    });
    socket.once('error', () => resolve('closed'));
  });
}

function hookStatus(codexHome) {
  const hooksPath = join(codexHome, 'hooks.json');
  if (!existsSync(hooksPath)) return 'not installed';
  try {
    const config = JSON.parse(readFileSync(hooksPath, 'utf8'));
    let count = 0;
    for (const groups of Object.values(config.hooks ?? {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
          if (isCodexyHook(hook)) count += 1;
        }
      }
    }
    return count > 0 ? `${count} Codexy entries merged` : 'no Codexy entries';
  } catch {
    return 'hooks.json is invalid JSON';
  }
}

function serviceStatus() {
  if (platform() === 'linux') {
    const result = spawnSync(
      'systemctl',
      ['--user', 'is-active', 'codexy.service'],
      { encoding: 'utf8', timeout: 5_000 },
    );
    return (result.stdout || result.stderr).trim() || 'unavailable';
  }
  if (platform() === 'darwin') {
    const runtime = join(
      process.env.CODEX_HOME || join(homedir(), '.codex'),
      'codexy',
    );
    const domainPath = join(runtime, 'service-domain');
    const domain = existsSync(domainPath)
      ? readFileSync(domainPath, 'utf8').trim()
      : `gui/${process.getuid()}`;
    const result = spawnSync(
      'launchctl',
      ['print', `${domain}/com.codexy.relay`],
      { encoding: 'utf8', timeout: 5_000 },
    );
    return result.status === 0 ? 'active' : 'unavailable';
  }
  return 'unsupported';
}

const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const runtime = join(codexHome, 'codexy');
const installRecord = join(runtime, 'install.json');
let launcher = 'not recorded';
if (existsSync(installRecord)) {
  try {
    launcher =
      JSON.parse(readFileSync(installRecord, 'utf8')).launcherPath ?? launcher;
  } catch {
    launcher = 'invalid install record';
  }
}

console.log('Codexy read-only diagnostics');
console.log('============================');
console.log(`Platform    : ${platform()}`);
console.log(`Node        : ${process.version}`);
console.log(`Codex CLI   : ${commandVersion('codex', ['--version'])}`);
console.log(`Service     : ${serviceStatus()}`);
console.log(`Port 8797   : ${await portStatus(8797)} (Relay/PWA)`);
console.log(`Port 4510   : ${await portStatus(4510)} (Codex App Server)`);
console.log(`Hook config : ${hookStatus(codexHome)}`);
console.log(
  `Hook files  : ${
    existsSync(join(codexHome, 'codexy-hooks', '.codexy-managed.json'))
      ? 'installed'
      : 'not installed'
  }`,
);
console.log(`Launcher    : ${launcher}`);
console.log(`Runtime     : ${runtime}`);
console.log('');
console.log('This command made no changes.');

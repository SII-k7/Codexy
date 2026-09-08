import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// Scope the Hub entry point to child processes; preserve desktop config.
for (const args of [
  ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--output-dir', 'output/hub-web'],
  ['scripts/verify-pwa-build.mjs', 'output/hub-web'],
  ['scripts/package-hub.mjs'],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root, stdio: 'inherit', env: { ...process.env, EXPO_PUBLIC_CODEXY_HUB: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

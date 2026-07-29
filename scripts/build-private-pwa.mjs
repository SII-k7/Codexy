import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const buildsRoot = resolve(root, 'web-builds');
const buildName = `build-${new Date()
  .toISOString()
  .replace(/[^0-9]/g, '')
  .slice(0, 14)}-${process.pid}`;
const outputPath = resolve(buildsRoot, buildName);
const relativeOutput = relative(root, outputPath).replaceAll('\\', '/');

mkdirSync(buildsRoot, { recursive: true });

const expoCli = resolve(root, 'node_modules', 'expo', 'bin', 'cli');
if (!existsSync(expoCli)) {
  throw new Error('Expo CLI is missing. Run npm ci before private:build.');
}
const result = spawnSync(
  process.execPath,
  [expoCli, 'export', '--platform', 'web', '--output-dir', relativeOutput],
  {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
  throw new Error(`Expo export failed with exit code ${result.status ?? 1}`);
}

const verify = spawnSync(
  process.execPath,
  [resolve(root, 'scripts', 'verify-pwa-build.mjs'), relativeOutput],
  {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
  },
);
if (verify.error) throw verify.error;
if (verify.status !== 0) {
  process.exitCode = verify.status ?? 1;
  throw new Error(`PWA verification failed with exit code ${verify.status ?? 1}`);
}

const envPath = resolve(root, '.env.local');
let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const line = `CODEXY_WEB_ROOT=${relativeOutput}`;
const pattern = /^CODEXY_WEB_ROOT=.*$/m;
env = pattern.test(env)
  ? env.replace(pattern, line)
  : `${env.trimEnd()}${env.trim() ? '\n' : ''}${line}\n`;
writeFileSync(envPath, env.trimStart(), { encoding: 'utf8', mode: 0o600 });

// Build directories are immutable. Retain the current build and two previous
// ones so an interrupted export can never destroy the version being served.
const oldBuilds = readdirSync(buildsRoot)
  .map((name) => ({ name, path: resolve(buildsRoot, name) }))
  .filter(
    (entry) =>
      entry.name !== buildName &&
      entry.name.startsWith('build-') &&
      statSync(entry.path).isDirectory(),
  )
  .sort((left, right) => right.name.localeCompare(left.name))
  .slice(2);
for (const build of oldBuilds) {
  try {
    rmSync(build.path, { force: true, recursive: true });
  } catch {
    console.warn(`Could not remove old generated build: ${build.name}`);
  }
}

console.log(`Codexy private PWA ready at ${relativeOutput}`);
console.log('Updated CODEXY_WEB_ROOT in the local .env.local file.');

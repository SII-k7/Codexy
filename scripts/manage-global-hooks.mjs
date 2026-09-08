import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANAGED_DESCRIPTION =
  'Codexy privacy-minimized global Codex hooks.';
const MANAGED_FILES = [
  'capture_prompt.mjs',
  'capture_prompt.sh',
  'hook_common.mjs',
  'hooks.json',
  'notify_mobile.mjs',
  'notify_mobile.sh',
  'README.md',
];

export function isCodexyHook(hook) {
  if (!hook || typeof hook !== 'object') return false;
  return ['command', 'commandWindows'].some((propertyName) => {
    const value = hook[propertyName];
    return (
      typeof value === 'string' &&
      /[\\/]\.codex[\\/]codexy-hooks[\\/]/i.test(value)
    );
  });
}

export function removeCodexyEntries(config) {
  if (!config?.hooks || typeof config.hooks !== 'object') return 0;
  let removed = 0;
  for (const eventName of Object.keys(config.hooks)) {
    const groups = Array.isArray(config.hooks[eventName])
      ? config.hooks[eventName]
      : [];
    const retainedGroups = [];
    for (const group of groups) {
      const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
      const retainedHooks = hooks.filter((hook) => {
        if (!isCodexyHook(hook)) return true;
        removed += 1;
        return false;
      });
      if (retainedHooks.length > 0) {
        retainedGroups.push({ ...group, hooks: retainedHooks });
      }
    }
    if (retainedGroups.length > 0) {
      config.hooks[eventName] = retainedGroups;
    } else {
      delete config.hooks[eventName];
    }
  }
  return removed;
}

export function mergeCodexyEntries(targetConfig, sourceConfig) {
  if (!sourceConfig?.hooks || typeof sourceConfig.hooks !== 'object') {
    throw new Error('Codexy hook source does not contain a hooks object');
  }
  const config =
    targetConfig && typeof targetConfig === 'object' && !Array.isArray(targetConfig)
      ? structuredClone(targetConfig)
      : {};
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
  const replaced = removeCodexyEntries(config);
  let added = 0;
  for (const [eventName, groups] of Object.entries(sourceConfig.hooks)) {
    if (!Array.isArray(groups)) {
      throw new Error(`Codexy hook event ${eventName} is not an array`);
    }
    const clonedGroups = structuredClone(groups);
    added += clonedGroups.reduce(
      (total, group) =>
        total + (Array.isArray(group?.hooks) ? group.hooks.length : 0),
      0,
    );
    config.hooks[eventName] = [
      ...(Array.isArray(config.hooks[eventName])
        ? config.hooks[eventName]
        : []),
      ...clonedGroups,
    ];
  }
  if (!config.description) config.description = MANAGED_DESCRIPTION;
  return { config, replaced, added };
}

function readJson(path, label) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level value must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.codexy-${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
}

function requireManagedRuntime(runtimeDirectory) {
  if (!existsSync(runtimeDirectory)) return;
  const stat = lstatSync(runtimeDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Refusing to replace non-directory hook runtime: ${runtimeDirectory}`,
    );
  }
  const markerPath = join(runtimeDirectory, '.codexy-managed.json');
  if (!existsSync(markerPath)) {
    throw new Error(
      `Refusing to replace an unmarked hook directory: ${runtimeDirectory}`,
    );
  }
  const marker = readJson(markerPath, 'Codexy hook marker');
  if (marker.managedBy !== 'Codexy') {
    throw new Error(
      `Refusing to replace a hook directory with an unknown marker: ${runtimeDirectory}`,
    );
  }
}

export function installHooks({ sourceDirectory, codexHome, nodePath }) {
  const source = resolve(sourceDirectory);
  const home = resolve(codexHome);
  const runtimeDirectory = join(home, 'codexy-hooks');
  const hooksPath = join(home, 'hooks.json');
  const backupPath = join(home, 'hooks.json.codexy-backup');

  for (const fileName of MANAGED_FILES) {
    const sourceFile = join(source, fileName);
    if (!existsSync(sourceFile) || !lstatSync(sourceFile).isFile()) {
      throw new Error(`Missing reviewed Codexy hook file: ${sourceFile}`);
    }
  }
  if (!nodePath || !existsSync(nodePath) || !lstatSync(nodePath).isFile()) {
    throw new Error(`Node.js executable was not found: ${nodePath || '-'}`);
  }
  requireManagedRuntime(runtimeDirectory);

  const sourceConfig = readJson(join(source, 'hooks.json'), 'Codexy hook source');
  const existingConfig = existsSync(hooksPath)
    ? readJson(hooksPath, 'Existing global hook configuration')
    : { description: MANAGED_DESCRIPTION, hooks: {} };
  const result = mergeCodexyEntries(existingConfig, sourceConfig);

  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (existsSync(hooksPath)) copyFileSync(hooksPath, backupPath);
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  for (const fileName of MANAGED_FILES) {
    const targetFile = join(runtimeDirectory, fileName);
    copyFileSync(join(source, fileName), targetFile);
    chmodSync(targetFile, fileName.endsWith('.sh') ? 0o700 : 0o600);
  }
  writeFileSync(join(runtimeDirectory, 'node-path'), `${resolve(nodePath)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  writeJsonAtomic(join(runtimeDirectory, '.codexy-managed.json'), {
    managedBy: 'Codexy',
    installedAtUtc: new Date().toISOString(),
    source,
  });
  writeJsonAtomic(hooksPath, result.config);
  return {
    ...result,
    runtimeDirectory,
    hooksPath,
    backupPath: existsSync(backupPath) ? backupPath : null,
  };
}

export function removeHooks({ codexHome }) {
  const home = resolve(codexHome);
  const runtimeDirectory = join(home, 'codexy-hooks');
  const hooksPath = join(home, 'hooks.json');
  let removed = 0;
  let removedConfig = false;

  if (existsSync(hooksPath)) {
    const config = readJson(hooksPath, 'Existing global hook configuration');
    removed = removeCodexyEntries(config);
    const noEvents = Object.keys(config.hooks ?? {}).length === 0;
    if (noEvents && config.description === MANAGED_DESCRIPTION) {
      rmSync(hooksPath);
      removedConfig = true;
    } else if (removed > 0) {
      writeJsonAtomic(hooksPath, config);
    }
  }

  if (existsSync(runtimeDirectory)) {
    requireManagedRuntime(runtimeDirectory);
    if (
      dirname(resolve(runtimeDirectory)) !== home ||
      basename(runtimeDirectory) !== 'codexy-hooks'
    ) {
      throw new Error(`Refusing to remove unexpected path: ${runtimeDirectory}`);
    }
    rmSync(runtimeDirectory, { recursive: true });
  }
  return { removed, removedConfig, runtimeDirectory, hooksPath };
}

function parseArguments(argv) {
  const [action, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name.startsWith('--') || index + 1 >= rest.length) {
      throw new Error(`Invalid argument: ${name}`);
    }
    values[name.slice(2)] = rest[index + 1];
    index += 1;
  }
  return { action, values };
}

function runCli() {
  const { action, values } = parseArguments(process.argv.slice(2));
  if (!values['codex-home']) {
    throw new Error('--codex-home is required');
  }
  if (action === 'install') {
    if (!values['source-dir'] || !values.node) {
      throw new Error('install requires --source-dir and --node');
    }
    const result = installHooks({
      sourceDirectory: values['source-dir'],
      codexHome: values['codex-home'],
      nodePath: values.node,
    });
    console.log(
      `Installed ${result.added} Codexy hook entries in ${result.hooksPath}.`,
    );
    if (result.replaced > 0) {
      console.log(`Replaced ${result.replaced} previous Codexy hook entries.`);
    }
    if (result.backupPath) {
      console.log(`Previous hook configuration backup: ${result.backupPath}`);
    }
    return;
  }
  if (action === 'remove') {
    const result = removeHooks({ codexHome: values['codex-home'] });
    console.log(`Removed ${result.removed} Codexy hook entries.`);
    return;
  }
  throw new Error('Expected action: install or remove');
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    runCli();
  } catch (error) {
    console.error(`Codexy hook setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

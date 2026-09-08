import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import webpush from 'web-push';

const root = resolve(import.meta.dirname, '..');
const envPath = resolve(root, '.env.local');
const codexHome = process.env.CODEX_HOME
  ? resolve(process.env.CODEX_HOME)
  : join(homedir(), '.codex');
let content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

function currentValue(key) {
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function setValue(key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.trimEnd()}${content.trim() ? '\n' : ''}${line}\n`;
}

function removeValue(key) {
  const pattern = new RegExp(`^${key}=.*(?:\\r?\\n|$)`, 'm');
  content = content.replace(pattern, '');
}

let publicKey =
  currentValue('CODEXY_VAPID_PUBLIC_KEY') ||
  currentValue('ATTENTION_VAPID_PUBLIC_KEY');
let privateKey =
  currentValue('CODEXY_VAPID_PRIVATE_KEY') ||
  currentValue('ATTENTION_VAPID_PRIVATE_KEY');
if (!publicKey || !privateKey) {
  const generated = webpush.generateVAPIDKeys();
  publicKey = generated.publicKey;
  privateKey = generated.privateKey;
}

// A private PWA talks to the Relay through the same Tailscale HTTPS origin.
// Leaving a development URL here would be compiled into the phone bundle.
removeValue('EXPO_PUBLIC_RELAY_URL');
for (const key of [
  'ATTENTION_RELAY_HOST',
  'ATTENTION_RELAY_PORT',
  'ATTENTION_RELAY_STATE_FILE',
  'ATTENTION_WEB_ROOT',
  'ATTENTION_CODEX_CONTROL',
  'ATTENTION_CODEX_APP_SERVER_URL',
  'ATTENTION_VAPID_SUBJECT',
  'ATTENTION_VAPID_PUBLIC_KEY',
  'ATTENTION_VAPID_PRIVATE_KEY',
]) {
  removeValue(key);
}
setValue('CODEXY_RELAY_HOST', '127.0.0.1');
setValue('CODEXY_RELAY_PORT', '8797');
setValue('CODEXY_NODE_COMMAND', JSON.stringify(process.execPath));
setValue(
  'CODEXY_RELAY_STATE_FILE',
  join(codexHome, 'codexy', 'relay-state.json').replaceAll(
    '\\',
    '/',
  ),
);
// private:build replaces this placeholder with its fresh immutable build path.
// A new directory per export avoids a half-cleaned PWA if Expo is interrupted.
setValue('CODEXY_WEB_ROOT', 'web-builds/latest');
setValue('CODEXY_CODEX_CONTROL', 'true');
setValue(
  'CODEXY_CODEX_APP_SERVER_URL',
  currentValue('CODEXY_CODEX_APP_SERVER_URL') ||
    'ws://127.0.0.1:4510',
);
const configuredCodexCommand =
  currentValue('CODEXY_CODEX_COMMAND').replace(/^"(.*)"$/, '$1') ||
  process.env.CODEXY_CODEX_COMMAND ||
  '';
if (configuredCodexCommand) {
  setValue(
    'CODEXY_CODEX_COMMAND',
    JSON.stringify(configuredCodexCommand),
  );
}
setValue(
  'CODEXY_VAPID_SUBJECT',
  currentValue('CODEXY_VAPID_SUBJECT') ||
    'mailto:self@example.com',
);
setValue('CODEXY_VAPID_PUBLIC_KEY', publicKey);
setValue('CODEXY_VAPID_PRIVATE_KEY', privateKey);

writeFileSync(envPath, content.trimStart(), {
  encoding: 'utf8',
  mode: 0o600,
});
try {
  chmodSync(envPath, 0o600);
} catch {
  // Windows permissions are managed by the current user profile.
}

console.log('Configured Codexy .env.local for private PWA use.');
console.log('VAPID private key was kept local and was not printed.');
console.log('Codex control stays on the localhost App Server endpoint.');

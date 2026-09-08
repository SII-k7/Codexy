import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const web = resolve(root, process.argv[2] ?? 'output/hub-web');
const destination = resolve(root, 'output/nas/hub-package');
const release = resolve(destination, 'release');
mkdirSync(release, { recursive: true });
for (const dir of ['hub', 'relay', 'vendor']) mkdirSync(resolve(release, dir), { recursive: true });
for (const name of ['server.mjs', 'protocol.mjs', 'Dockerfile']) cpSync(resolve(root, 'hub', name), resolve(release, 'hub', name));
for (const name of ['change-feed.mjs', 'static-web.mjs']) cpSync(resolve(root, 'relay', name), resolve(release, 'relay', name));
// ws is pure JavaScript; package only its installed runtime and license.
const ws = JSON.parse(readFileSync(resolve(root, 'node_modules/ws/package.json'), 'utf8'));
if (ws.version !== '7.5.13') throw new Error('Review the ws runtime version before packaging');
cpSync(resolve(root, 'node_modules/ws'), resolve(release, 'vendor/ws'), { recursive: true });
cpSync(web, resolve(release, 'web'), { recursive: true });
cpSync(resolve(root, 'hub/compose.yaml'), resolve(destination, 'compose.yaml'));
const installer = readFileSync(resolve(root, 'scripts/install-hub-fnos.sh'), 'utf8').replaceAll('\r\n', '\n');
writeFileSync(resolve(destination, 'install.sh'), installer);
cpSync(resolve(root, 'scripts/prepare-hub-config.py'), resolve(destination, 'prepare-hub-config.py'));
console.log('Codexy Hub package prepared without credentials.');

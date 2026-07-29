import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outputDirectory = process.argv[2] || 'web-dist';
const required = [
  `${outputDirectory}/index.html`,
  `${outputDirectory}/manifest.json`,
  `${outputDirectory}/sw.js`,
  `${outputDirectory}/icon-192.png`,
  `${outputDirectory}/icon-512.png`,
];
const missing = required.filter((file) => !existsSync(resolve(root, file)));
if (missing.length) {
  throw new Error(`PWA build is missing: ${missing.join(', ')}`);
}

const html = readFileSync(
  resolve(root, outputDirectory, 'index.html'),
  'utf8',
);
if (!html.includes('rel="manifest"') || !html.includes('/sw.js')) {
  throw new Error('PWA manifest or service worker is not linked from HTML');
}
const manifest = JSON.parse(
  readFileSync(resolve(root, outputDirectory, 'manifest.json'), 'utf8'),
);
if (manifest.display !== 'standalone' || manifest.icons?.length < 2) {
  throw new Error('PWA manifest is incomplete');
}
if (manifest.name !== 'Codexy' || manifest.id !== '/codexy') {
  throw new Error('PWA manifest is not isolated for Codexy');
}
const serviceWorker = readFileSync(
  resolve(root, outputDirectory, 'sw.js'),
  'utf8',
);
if (!serviceWorker.includes("codexy-shell-")) {
  throw new Error('PWA cache namespace is not isolated for Codexy');
}
console.log('Codexy private PWA build verified.');

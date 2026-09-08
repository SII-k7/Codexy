import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const readText = (path) => readFileSync(resolve(root, path), 'utf8');
const readJson = (path) => JSON.parse(readText(path));

const packageJson = readJson('package.json');
const appJson = readJson('app.json');
const manifest = readJson('public/manifest.json');
const serviceWorker = readText('public/sw.js');
const envExample = readText('.env.example');
const hookInstaller = readText('scripts/install-global-hooks.ps1');
const unixInstaller = readText('scripts/setup-codexy-unix.sh');
const unixBootstrap = readText('install.sh');
const startupScript = readText('scripts/start-private-pwa.ps1');
const expo = appJson.expo;

const failures = [];
const requireValue = (condition, message) => {
  if (!condition) failures.push(message);
};

requireValue(packageJson.name === 'codexy-app', 'package name 必须是 codexy-app');
requireValue(packageJson.version === '0.1.0', 'MVP 版本必须是 0.1.0');
requireValue(expo.name === 'Codexy', 'Expo 应用名必须是 Codexy');
requireValue(expo.slug === 'codexy', 'Expo slug 必须是 codexy');
requireValue(expo.scheme === 'codexy', 'URL scheme 必须是 codexy');
requireValue(expo.version === packageJson.version, 'package 与 Expo 版本不一致');
requireValue(
  expo.ios?.bundleIdentifier === 'app.codexy.mobile',
  'iOS bundleIdentifier 未隔离',
);
requireValue(
  expo.android?.package === 'app.codexy.mobile',
  'Android package 未隔离',
);
requireValue(manifest.name === 'Codexy', 'PWA 名称必须是 Codexy');
requireValue(manifest.id === '/codexy', 'PWA 安装 ID 未隔离');
requireValue(
  serviceWorker.includes("codexy-shell-") &&
    !serviceWorker.includes("attention-shell-"),
  'Service Worker 缓存命名空间未隔离',
);
requireValue(
  envExample.includes('CODEXY_RELAY_PORT=8797'),
  'Relay 默认端口必须是 8797',
);
requireValue(
  envExample.includes(
    'CODEXY_CODEX_APP_SERVER_URL=ws://127.0.0.1:4510',
  ),
  'Codex App Server 默认端口必须是 4510',
);
requireValue(
  packageJson.scripts?.['preview:iphone']?.includes('--port 8084'),
  'iPhone 预览端口必须是 8084',
);
requireValue(
  packageJson.scripts?.['update:apply']?.includes('update-codexy.ps1'),
  '缺少安全更新入口',
);
requireValue(
  hookInstaller.includes('capture_prompt.mjs') &&
    hookInstaller.includes('notify_mobile.mjs') &&
    !existsSync(
      resolve(root, 'scripts/global-codex-hooks/capture_prompt.py'),
    ) &&
    !existsSync(
      resolve(root, 'scripts/global-codex-hooks/notify_mobile.py'),
    ),
  '全局 Hook 必须只依赖 Node.js 运行时',
);
requireValue(
  unixInstaller.includes('systemctl --user') &&
    unixInstaller.includes('launchctl bootstrap') &&
    unixInstaller.includes('--host 127.0.0.1') &&
    unixBootstrap.includes('scripts/setup-codexy-unix.sh'),
  '缺少 Ubuntu/macOS 一键安装或 loopback-only 后台服务',
);
requireValue(
  !existsSync(resolve(root, '.codex/hooks.project-template.json')) &&
    !existsSync(resolve(root, '.codex/hooks/capture_prompt.cmd')) &&
    !existsSync(resolve(root, '.codex/hooks/capture_prompt.py')) &&
    !existsSync(resolve(root, '.codex/hooks/notify_mobile.cmd')) &&
    !existsSync(resolve(root, '.codex/hooks/notify_mobile.py')),
  '仓库不得保留旧的项目级 Attention/Python Hook',
);
requireValue(
  !startupScript.includes('E:\\vibe coding'),
  '启动脚本不得包含开发机 Node 路径',
);
requireValue(
  envExample.includes('CODEXY_ALLOWED_ORIGINS='),
  '缺少显式开发 Origin 配置',
);

for (const file of [
  'assets/codexy-icon-source.png',
  'assets/icon.png',
  'assets/android-icon-foreground.png',
  'assets/android-icon-monochrome.png',
  'assets/favicon.png',
  'assets/splash-icon.png',
  'public/apple-touch-icon-180.png',
  'public/icon-192.png',
  'public/icon-512.png',
]) {
  requireValue(existsSync(resolve(root, file)), `缺少 ${file}`);
}

console.log(`Codexy ${expo.version} · MVP readiness`);
if (failures.length) {
  console.error('配置未通过：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('  ✓ 应用身份与版本独立');
  console.log('  ✓ Relay 与预览端口独立');
  console.log('  ✓ PWA 安装身份与缓存独立');
  console.log('  ✓ 图标资源齐全');
}
console.log('');
console.log('此检查不代表 App Store、Play Store 或生产云服务已就绪。');

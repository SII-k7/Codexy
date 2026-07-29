import { CodexControlBridge } from './codex-control.mjs';

const bridge = new CodexControlBridge({
  enabled: true,
  url:
    process.env.CODEXY_CODEX_APP_SERVER_PROBE_URL ??
    process.env.ATTENTION_CODEX_APP_SERVER_PROBE_URL ??
    'ws://127.0.0.1:4517',
  codexCommand:
    process.env.CODEXY_CODEX_COMMAND ??
    process.env.ATTENTION_CODEX_COMMAND ??
    (process.platform === 'win32' ? 'codex.cmd' : 'codex'),
  spawnServer: true,
});

try {
  await bridge.start();
  console.log(JSON.stringify(bridge.getStatus(), null, 2));
} finally {
  bridge.stop();
}

// The probe owns every process it starts. Exit explicitly after the Windows
// process tree has been terminated so inherited CLI handles cannot keep a
// diagnostic command open.
process.exit(0);

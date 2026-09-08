const code = process.argv[2];
const relayUrl = (
  process.argv[3] ??
  process.env.CODEXY_RELAY_BASE_URL ??
  process.env.ATTENTION_RELAY_BASE_URL ??
  'http://127.0.0.1:8797'
)
  .replace(/\/+$/, '');

if (!/^\d{6}$/.test(code ?? '')) {
  console.error(
    'Usage: codexy pair <six-digit-code> (or npm run relay:claim -- <six-digit-code>)',
  );
  process.exit(1);
}

try {
  const response = await fetch(`${relayUrl}/v1/pairings/claim`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pairing_code: code }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error ?? `HTTP ${response.status}`);
  }

  console.log('Codexy pairing complete.');
  console.log(
    'Installed hooks will discover this single paired device from the local Relay state.',
  );
  console.log(
    process.platform === 'win32'
      ? "No bearer token is printed. Optional project alias: $env:CODEXY_PROJECT_ALIAS='My project'"
      : "No bearer token is printed. Optional project alias: export CODEXY_PROJECT_ALIAS='My project'",
  );
} catch (error) {
  console.error(
    `Pairing failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

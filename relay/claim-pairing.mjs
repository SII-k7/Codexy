const code = process.argv[2];
const relayUrl = (
  process.argv[3] ??
  process.env.CODEXY_RELAY_BASE_URL ??
  process.env.ATTENTION_RELAY_BASE_URL ??
  'http://127.0.0.1:8797'
)
  .replace(/\/+$/, '');

if (!/^\d{6}$/.test(code ?? '')) {
  console.error('Usage: npm run relay:claim -- <six-digit-code> [relay-base-url]');
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

  console.log('Codexy pairing complete. Optional per-terminal overrides:');
  console.log(`$env:CODEXY_RELAY_URL='${relayUrl}/v1/events'`);
  console.log(`$env:CODEXY_RELAY_TOKEN='${result.relay_token}'`);
  console.log(`$env:CODEXY_PROJECT_ALIAS='My project'`);
} catch (error) {
  console.error(
    `Pairing failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

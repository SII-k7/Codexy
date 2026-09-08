import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromptSender } from './promptDelivery.ts';
const input = { relayUrl: 'https://one.example', deviceId: 'phone', deviceSecret: 'secret', sessionRef: 'sha256:1111222233334444', prompt: 'continue', mode: 'queue' };

test('lost HTTP response can be retried with the same target-bound request ID', async () => {
  const calls = []; let fail = true; let sequence = 0;
  const sender = createPromptSender(async (value) => { calls.push(value); if (fail) throw Error('timeout'); return { command_id: 'receipt' }; }, () => false, () => `key-${++sequence}`);
  await assert.rejects(sender.submit(input)); fail = false;
  await sender.submit(input);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
  await sender.submit({ ...input, relayUrl: 'https://two.example' });
  assert.notEqual(calls[1].idempotencyKey, calls[2].idempotencyKey);
});
test('simultaneous taps share a single submission', async () => {
  let finish; let calls = 0;
  const sender = createPromptSender(() => { calls++; return new Promise((resolve) => { finish = resolve; }); }, () => false);
  const first = sender.submit(input); const second = sender.submit(input);
  assert.equal(first, second); assert.equal(calls, 1);
  finish({ command_id: 'receipt' }); await first;
});

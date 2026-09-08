import assert from 'node:assert/strict';
import test from 'node:test';
import { latestSessionPrompt, sessionPhase } from './sessionPresentation.ts';

test('only confirmed current work is counted as running; offline and historical work remain unknown', () => {
  assert.equal(sessionPhase({ state: 'working', activity_confirmed: true }, true), 'running');
  assert.equal(sessionPhase({ state: 'working', activity_confirmed: false }, true), 'unknown');
  assert.equal(sessionPhase({ state: 'working' }, true), 'unknown');
  assert.equal(sessionPhase({ state: 'working', activity_confirmed: true }, false), 'unknown');
  assert.equal(sessionPhase({ state: 'needs_you', activity_confirmed: false }, true), 'unknown');
});
test('completed rounds wait for new prompts, while approval requests and failures stay distinct', () => {
  assert.equal(sessionPhase({ state: 'turn_finished' }, true), 'waiting');
  assert.equal(sessionPhase({ state: 'completed' }, true), 'waiting');
  assert.equal(sessionPhase({ state: 'needs_you', activity_confirmed: true }, true), 'attention');
  assert.equal(sessionPhase({ state: 'failed' }, true), 'attention');
  assert.equal(sessionPhase({ state: 'interrupted' }, true), 'attention');
  assert.equal(sessionPhase({ state: 'turn_finished' }, false), 'unknown');
});
test('last prompt is selected by capture time without changing stored prompt order', () => {
  const prompts = [{ text: 'older', captured_at: '2026-09-07T12:00:00Z' }, { text: 'newer', captured_at: '2026-09-08T12:00:00Z' }];
  assert.equal(latestSessionPrompt({ prompts }).text, 'newer');
  assert.equal(prompts[0].text, 'older');
  assert.equal(latestSessionPrompt({ prompts: [] }), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSessionActivity } from './session-projection.mjs';

test('runtime status distinguishes active work from awaiting input without reading transcript', () => {
  const session = { state: 'working', summary: 'old', acknowledged_at: 'old-ack' };
  const result = projectSessionActivity(session, { type: 'active', needsInput: true, observedAt: 'now' });
  assert.equal(result.state, 'needs_you'); assert.equal(result.acknowledged_at, null);
  assert.equal(result.status_source, 'app_server'); assert.equal(session.state, 'working');
});
test('idle does not imply overall completion, and absent runtime evidence remains unconfirmed', () => {
  assert.equal(projectSessionActivity({ state: 'working' }, { type: 'idle' }).state, 'turn_finished');
  assert.equal(projectSessionActivity({ state: 'failed' }, { type: 'idle' }).state, 'failed');
  assert.equal(projectSessionActivity({ state: 'working' }, null).activity_confirmed, false);
});

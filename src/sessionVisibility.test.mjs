import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attentionEligibleSessions,
  visibleSessionTracks,
} from './sessionVisibility.ts';

function session(sessionRef, state) {
  return {
    session_ref: sessionRef,
    source: 'codex',
    project_alias: sessionRef,
    state,
    summary: state,
    updated_at: '2026-07-30T08:00:00.000Z',
    prompts: [],
    prompt_count: 0,
  };
}

test('hides a session only from the regular track list', () => {
  const hidden = session('sha256:1111222233334444', 'working');
  const visible = session('sha256:5555666677778888', 'completed');
  const hiddenRefs = new Set([hidden.session_ref]);

  assert.deepEqual(visibleSessionTracks([hidden, visible], hiddenRefs), [
    visible,
  ]);
  assert.deepEqual(
    attentionEligibleSessions([hidden, visible], hiddenRefs),
    [visible],
  );
});

test('keeps hidden decisions and failures in the attention queue', () => {
  const decision = session('sha256:1111222233334444', 'needs_you');
  const failure = session('sha256:5555666677778888', 'failed');
  const hiddenRefs = new Set([decision.session_ref, failure.session_ref]);

  assert.deepEqual(visibleSessionTracks([decision, failure], hiddenRefs), []);
  assert.deepEqual(
    attentionEligibleSessions([decision, failure], hiddenRefs),
    [decision, failure],
  );
});

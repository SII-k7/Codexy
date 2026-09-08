import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveSync } from './liveSync.ts';
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

test('event revisions survive snapshot reads; background aborts and resume starts fresh', async () => {
  const calls = []; let resolveWatch; let snapshots = 0;
  const feed = createLiveSync({ watch(revision, signal) {
    calls.push({ revision, signal }); return new Promise((resolve) => { resolveWatch = resolve; });
  }, async refresh() { snapshots++; }, onError() { assert.fail('unexpected failure'); } });
  feed.setActive(true); resolveWatch({ revision: 'v1', changed: true }); await wait(120);
  assert.equal(snapshots, 1); assert.equal(calls[1].revision, 'v1');
  feed.setActive(false); assert.equal(calls[1].signal.aborted, true);
  resolveWatch({ revision: 'late', changed: true }); await wait(); assert.equal(snapshots, 1);
  feed.setActive(true); assert.equal(calls[2].revision, null); feed.close();
});

test('old relay fallback is low frequency and a reconnect does not reuse stale revision', async () => {
  let snapshots = 0; let errors = 0; const revisions = [];
  const feed = createLiveSync({ retryMs: 30, async watch(revision) {
    revisions.push(revision);
    if (revisions.length === 1) throw Object.assign(Error('old relay'), { status: 404 });
    if (revisions.length === 2) throw Error('offline');
    return new Promise(() => {});
  }, async refresh() { snapshots++; }, onError() { errors++; } });
  feed.setActive(true); await wait(10); assert.equal(snapshots, 1); assert.equal(revisions.length, 1);
  await wait(70); assert.equal(errors, 1); assert.deepEqual(revisions, [null, null, null]); feed.close();
});

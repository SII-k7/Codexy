import assert from 'node:assert/strict';
import test from 'node:test';
import { createFleetPoller, fleetTasks, hostKey, hostOnline, taskKey } from './fleet.ts';

const host = (name) => ({ relayUrl: `https://${name}.example`, deviceId: 'same-phone', deviceSecret: name });
const session = (state) => ({ session_ref: 'sha256:1111222233334444', state, updated_at: '2026-09-07T00:00:00Z' });
const snapshot = (state = 'working') => ({ sessions: [session(state)], commands: [], events: [], next_cursor: 0 });
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('a reachable hub cannot make a disconnected desktop look online', () => {
  assert.equal(hostOnline({ error: null, lastSuccessAt: 100, snapshot: { ...snapshot(), hub_online: false } }, 101), false);
});
function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('same thread hashes on different computers have distinct task and draft scopes', () => {
  assert.notEqual(hostKey(host('a')), hostKey(host('b')));
  assert.notEqual(taskKey(host('a'), session().session_ref), taskKey(host('b'), session().session_ref));
});
test('a blocked computer does not delay other snapshots and reads never overlap', async () => {
  const blocked = deferred(); const calls = []; let visible;
  const poller = createFleetPoller(async (item) => { calls.push(item.deviceSecret); return item.deviceSecret === 'a' ? blocked.promise : snapshot(); }, (value) => { visible = value; }, () => 100);
  poller.setHosts([host('a'), host('b')]);
  const first = poller.refresh(); const second = poller.refresh();
  await tick();
  assert.equal(visible.find((item) => item.host.deviceSecret === 'b').lastSuccessAt, 100);
  assert.deepEqual(calls, ['a', 'b']);
  blocked.resolve(snapshot()); await Promise.all([first, second]); poller.close();
});
test('a disconnected computer retains a visibly stale snapshot and ages out without poll errors', async () => {
  let fail = false; let visible;
  const poller = createFleetPoller(async () => { if (fail) throw Error('offline'); return snapshot(); }, (value) => { visible = value; }, () => 100);
  poller.setHosts([host('a')]); await poller.refresh();
  assert.equal(hostOnline(visible[0], 100), true);
  assert.equal(hostOnline(visible[0], 40100), false);
  fail = true; await poller.refresh();
  assert.equal(visible[0].snapshot.sessions.length, 1);
  assert.equal(fleetTasks(visible, 100)[0].online, false); poller.close();
});
test('removed or recredentialed computers cannot be resurrected by late responses', async () => {
  const slow = deferred(); let visible;
  const poller = createFleetPoller(() => slow.promise, (value) => { visible = value; });
  poller.setHosts([host('a')]); const pending = poller.refresh();
  poller.setHosts([]); slow.resolve(snapshot()); await pending;
  assert.deepEqual(visible, []); poller.close();
});
test('attention sorts across computers and normal work is excluded from action counts', () => {
  const entries = ['working', 'turn_finished', 'failed', 'needs_you', 'interrupted'].map((state, index) => ({ host: host(String(index)), snapshot: snapshot(state), lastSuccessAt: 100, error: null }));
  const tasks = fleetTasks(entries, 100);
  assert.deepEqual(tasks.map((task) => task.session.state), ['needs_you', 'failed', 'interrupted', 'turn_finished', 'working']);
  assert.equal(tasks.filter((task) => task.attention).length, 4);
});

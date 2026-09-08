import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createChangeFeed } from './change-feed.mjs';

test('quiet feed heartbeats retain revision and disconnected responses release their watcher', async () => {
  const feed = createChangeFeed({ waitMs: 20 });
  let first;
  feed.watch({}, new EventEmitter(), null, () => true, (_response, _status, body) => { first = body; });
  const response = new EventEmitter();
  // Keep the test alive while the server's production timer is unref'ed.
  const hold = setTimeout(() => {}, 1000);
  const heartbeat = await new Promise((resolve) => feed.watch({}, response, first.revision, () => true, (_response, _status, body) => resolve(body)));
  clearTimeout(hold);
  assert.deepEqual(heartbeat, { revision: first.revision, changed: false });
  assert.equal(response.listenerCount('close'), 0);
  const disconnected = new EventEmitter(); let sent = false;
  feed.watch({}, disconnected, first.revision, () => true, () => { sent = true; });
  disconnected.destroyed = true; disconnected.emit('close'); feed.notify();
  assert.equal(disconnected.listenerCount('close'), 0); assert.equal(sent, false); feed.close();
});

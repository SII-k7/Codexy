import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { AppServerRpc, CodexControlBridge, sessionRefForThreadId } from './codex-control.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('server approval IDs cannot resolve client RPCs; item content is ignored', () => {
  let resolved = false; let notification;
  const rpc = new AppServerRpc('ws://127.0.0.1', (method) => { notification = method; });
  rpc.pending.set('1', { resolve() { resolved = true; }, timer: null });
  rpc.handleMessage(Buffer.from(JSON.stringify({ id: 1, method: 'item/commandExecution/requestApproval', params: {} })));
  assert.equal(resolved, false); assert.equal(rpc.pending.size, 1);
  rpc.handleMessage(Buffer.from(JSON.stringify({ method: 'thread/status/changed', params: {} })));
  assert.equal(notification, 'thread/status/changed');
  rpc.handleMessage(Buffer.from(JSON.stringify({ id: 1, result: {} })));
  assert.equal(resolved, true);
  const bridge = new CodexControlBridge();
  bridge.handleNotification('item/agentMessage/delta', { threadId: 'private-thread', delta: 'private text' });
  assert.equal(bridge.threadIndex.size, 0);
});

test('a newer status event wins over an older list response; refreshes share one request', async () => {
  const bridge = new CodexControlBridge({ enabled: true }); bridge.state = 'ready';
  const id = 'private-thread'; const ref = sessionRefForThreadId(id);
  bridge.threadIndex.set(ref, { id, status: { type: 'idle' } });
  let finish; let reads = 0;
  bridge.rpc = { request() { reads++; return new Promise((resolve) => { finish = resolve; }); } };
  const first = bridge.refreshIndex(); const second = bridge.refreshIndex();
  bridge.handleNotification('thread/status/changed', { threadId: id, status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  finish({ data: [{ id, status: { type: 'idle' } }] }); await Promise.all([first, second]);
  assert.equal(reads, 1); assert.equal(bridge.activityForSession(ref).needsInput, true);
});

test('real websocket events update state and wake Queue without a polling delay', async (t) => {
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const id = 'private-thread'; const ref = sessionRefForThreadId(id);
  let socket; let status = { type: 'active', activeFlags: [] }; const calls = [];
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      const message = JSON.parse(data); if (!message.id) return;
      calls.push(message.method);
      if (message.method === 'thread/resume') assert.deepEqual(message.params, { threadId: id, excludeTurns: true });
      const thread = { id, status, canAcceptDirectInput: true };
      const result = message.method === 'thread/list' ? { data: [thread, { id: 'historical', status: { type: 'notLoaded' } }] }
        : message.method === 'turn/start' ? { turn: { id: 'next-turn' } }
        : { thread };
      ws.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const bridge = new CodexControlBridge({ enabled: true, spawnServer: false, url: `ws://127.0.0.1:${wss.address().port}` });
  t.after(async () => { bridge.stop(); for (const client of wss.clients) client.terminate(); await new Promise((resolve) => wss.close(resolve)); });
  await bridge.start();
  assert.equal(calls.filter((method) => method === 'thread/resume').length, 1);
  let waiting;
  const ready = new Promise((resolve) => { waiting = resolve; });
  const sending = bridge.dispatch({ sessionRef: ref, commandId: 'test-command', mode: 'queue', prompt: 'test only', expiresAtMs: Date.now() + 5000 }, (state) => { if (state === 'waiting') waiting(); });
  await ready; await tick();
  status = { type: 'idle' };
  socket.send(JSON.stringify({ method: 'thread/status/changed', params: { threadId: id, status } }));
  const started = Date.now();
  assert.equal((await sending).turnId, 'next-turn');
  assert.ok(Date.now() - started < 2000);
  assert.equal(calls.filter((method) => method === 'thread/list').length, 1);
  assert.equal(calls.filter((method) => method === 'thread/read').length, 2);
  // Socket loss immediately invalidates runtime evidence and starts recovery.
  bridge.connectWithRetry = async () => { throw Error('offline fixture'); };
  socket.terminate();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(bridge.activityForSession(ref), null);
});

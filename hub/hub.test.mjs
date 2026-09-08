import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { createHubServer, tokenHash } from './server.mjs';
import { createHubAgent } from './agent.mjs';
import { allowedRoute } from './protocol.mjs';
import { createChangeFeed } from '../relay/change-feed.mjs';

const secret = () => randomBytes(32).toString('base64url');
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function eventually(read, check, timeout = 3000) {
  const until = Date.now() + timeout;
  do { const value = await read(); if (check(value)) return value; await new Promise((resolve) => setTimeout(resolve, 20)); } while (Date.now() < until);
  assert.fail('condition did not become true');
}
async function fixture(t, options = {}) {
  const owner = secret(); const tokens = [secret(), secret()];
  const config = { ownerHash: tokenHash(owner), agents: tokens.map((token, i) => ({ id: `pc${i}`, label: `Computer ${i}`, tokenHash: tokenHash(token) })) };
  const hub = createHubServer({ getConfig: () => config, rpcTimeoutMs: 150, heartbeatMs: 40, staleMs: 5000, ...options });
  const url = await listen(hub.server);
  const agents = []; const relays = []; const feeds = []; const received = [[], []];
  const states = [{ state: 'working' }, { state: 'needs_you' }];
  for (let i = 0; i < 2; i++) {
    const feed = createChangeFeed({ waitMs: 500 }); feeds.push(feed);
    const relay = http.createServer(async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer local-secret-${i}`);
      const route = new URL(req.url, 'http://local');
      assert.ok(route.pathname.startsWith(`/v1/devices/local-${i}/`));
      const send = (response, status, result) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result)); };
      if (route.pathname.endsWith('/snapshot')) return send(res, 200, { status: { device_id: `local-${i}`, device_secret: 'never-export', paired: true }, sessions: [{ session_ref: 'same-hash', ...states[i] }], events: [], commands: [] });
      if (route.pathname.endsWith('/changes')) return feed.watch(req, res, route.searchParams.get('after'), () => true, send);
      let payload = ''; for await (const chunk of req) payload += chunk;
      received[i].push({ path: route.pathname, body: payload && JSON.parse(payload) });
      if (payload.includes('timeout-marker')) return;
      send(res, 202, { command: { command_id: 'cmd-1', status: 'sent' } });
    });
    relays.push(relay);
    const localUrl = await listen(relay);
    agents.push(createHubAgent({ hubUrl: url, hostId: `pc${i}`, token: tokens[i], localUrl, retryMs: 1000,
      resolveIdentity: () => ({ deviceId: `local-${i}`, deviceSecret: `local-secret-${i}` }),
    }));
  }
  const request = (path, method = 'GET', payload, token = owner) => fetch(url + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  t.after(() => { agents.forEach((agent) => agent.close()); feeds.forEach((feed) => feed.close()); hub.close(); hub.server.closeAllConnections(); hub.server.close(); relays.forEach((relay) => { relay.closeAllConnections(); relay.close(); }); });
  await eventually(async () => (await request('/v1/hub/hosts')).json(), (result) => result.hosts.every((host) => host.online));
  return { request, config, agents, received, states, feeds, url, tokens };
}

test('two outbound agents expose sanitized snapshots and route identical session refs to exactly one computer', async (t) => {
  const f = await fixture(t);
  const snapshot = await (await f.request('/h/pc1/v1/devices/pc1/snapshot')).json();
  assert.equal(snapshot.status.device_id, 'pc1'); assert.equal(snapshot.status.device_secret, undefined);
  assert.equal(snapshot.sessions[0].state, 'needs_you'); assert.equal(snapshot.hub_online, true);
  const result = await f.request('/h/pc1/v1/devices/pc1/remote-prompts', 'POST', { prompt: 'target one only', mode: 'queue', session_ref: 'same-hash', idempotency_key: 'test-key' });
  assert.equal(result.status, 202); assert.equal(f.received[0].length, 0); assert.equal(f.received[1].length, 1);
  assert.equal(f.received[1][0].body.prompt, 'target one only');
  assert.equal(f.received[1][0].path, '/v1/devices/local-1/remote-prompts');
});

test('event invalidation updates cached state without phone polling desktop', async (t) => {
  const f = await fixture(t);
  f.states[0].state = 'turn_finished'; f.feeds[0].notify();
  await eventually(async () => (await f.request('/h/pc0/v1/devices/pc0/snapshot')).json(), (s) => s.sessions[0].state === 'turn_finished');
});

test('disconnect retains explicitly stale snapshot and rejects new prompts without sending', async (t) => {
  const f = await fixture(t); f.agents[1].close();
  await eventually(async () => (await f.request('/h/pc1/v1/devices/pc1/snapshot')).json(), (s) => s.hub_online === false);
  const result = await f.request('/h/pc1/v1/devices/pc1/remote-prompts', 'POST', { prompt: 'do not queue' });
  assert.equal(result.status, 503); assert.equal(f.received[1].length, 0);
  assert.equal((await f.request('/h/pc0/v1/devices/pc0/snapshot')).status, 200);
});

test('owner authentication, host binding, route allowlist, and independent revocation', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/hub/hosts', 'GET', undefined, f.tokens[0])).status, 401);
  assert.equal((await f.request('/h/pc0/v1/devices/pc1/snapshot')).status, 404);
  assert.equal((await f.request('/h/pc0/v1/devices/pc0', 'DELETE')).status, 403);
  assert.equal((await f.request('/v1/pairings/claim', 'POST', {})).status, 404);
  f.config.agents[0].revoked = true;
  assert.equal((await f.request('/h/pc0/v1/devices/pc0/snapshot')).status, 404);
  assert.equal((await f.request('/h/pc1/v1/devices/pc1/snapshot')).status, 200);
  f.config.ownerHash = tokenHash(secret());
  assert.equal((await f.request('/v1/hub/hosts')).status, 401);
});

test('uncertain command timeout never retries or broadcasts the original prompt', async (t) => {
  const f = await fixture(t);
  const result = await f.request('/h/pc0/v1/devices/pc0/remote-prompts', 'POST', { prompt: 'timeout-marker' });
  assert.equal(result.status, 504); assert.equal((await result.json()).error_code, 'delivery_unknown');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(f.received[0].length, 1); assert.equal(f.received[1].length, 0);
});

test('tunnel rejects pairing, traversal, foreign URLs, and an incorrect agent credential', async (t) => {
  assert.equal(allowedRoute('GET', '/sessions/sha256%3Aabcdef1234567890/reply-summary'), true);
  for (const path of ['/../../secret', '/snapshot?url=http://x', '//evil', '/sessions/%2f/control', '/pairings/claim']) assert.equal(allowedRoute('GET', path), false);
  const f = await fixture(t);
  const ws = new WebSocket(`${f.url.replace('http', 'ws')}/v1/hub/agents/pc0`, { headers: { Authorization: `Bearer ${f.tokens[1]}` } });
  await new Promise((resolve) => { ws.on('unexpected-response', (_req, response) => { assert.equal(response.statusCode, 401); response.resume(); ws.terminate(); resolve(); }); ws.on('error', () => {}); });
});

test('runtime and goal commands follow exactly the chosen host through the tunnel', async (t) => {
  assert.equal(allowedRoute('GET','/sessions/sha256%3Aabcdef/runtime'),true);
  assert.equal(allowedRoute('PATCH','/sessions/sha256%3Aabcdef/goal'),true);
  assert.equal(allowedRoute('POST','/sessions/sha256%3Aabcdef/goal'),false);
  const f=await fixture(t);
  const result=await f.request('/h/pc1/v1/devices/pc1/sessions/sha256%3Aabcdef/goal','PATCH',{action:'set',objective:'target only',idempotency_key:'goal-fixture-1'});
  assert.equal(result.status,202); assert.equal(f.received[0].length,0); assert.equal(f.received[1].length,1);
  assert.equal(f.received[1][0].path,'/v1/devices/local-1/sessions/sha256%3Aabcdef/goal');
});

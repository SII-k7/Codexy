import WebSocket from 'ws';
import { allowedRoute, publicResult } from './protocol.mjs';

// Runs inside the local Relay. Desktop credentials never leave this process.
export function createHubAgent({ hubUrl, hostId, token, localUrl, resolveIdentity, retryMs = 5000 }) {
  const hub = new URL(hubUrl);
  const local = new URL(localUrl);
  if (hub.protocol !== 'https:' && !(hub.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(hub.hostname))) throw new Error('Hub requires private HTTPS');
  if (hub.pathname !== '/' || hub.search || hub.hash || hub.username || hub.password) throw new Error('Hub URL must be an origin');
  if (local.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname)) throw new Error('Relay must use loopback');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(hostId) || typeof token !== 'string' || token.length < 32) throw new Error('Invalid Hub enrollment');
  const endpoint = `${hub.origin.replace(/^http/, 'ws')}/v1/hub/agents/${hostId}`;
  let closed = false; let socket; let retry; let activeAbort;
  const pending = new Set();
  function send(value) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
  async function localRequest(identity, path, method = 'GET', payload, signal) {
    const result = await fetch(`${local.origin}/v1/devices/${encodeURIComponent(identity.deviceId)}${path}`, {
      method, headers: { Authorization: `Bearer ${identity.deviceSecret}`, 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload), signal,
      redirect: 'error',
    });
    return { status: result.status, body: publicResult(await result.json(), hostId) };
  }
  async function publish(signal) {
    let revision = null;
    while (!signal.aborted) {
      const identity = resolveIdentity();
      if (!identity) { send({ type: 'unavailable' }); throw new Error('Relay requires local pairing'); }
      const result = await localRequest(identity, '/snapshot', 'GET', undefined, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
      if (result.status !== 200) throw new Error('Snapshot unavailable');
      send({ type: 'snapshot', snapshot: result.body });
      const change = await localRequest(identity, `/changes${revision ? `?after=${encodeURIComponent(revision)}` : ''}`, 'GET', undefined, AbortSignal.any([signal, AbortSignal.timeout(35_000)]));
      if (change.status !== 200) throw new Error('Change feed unavailable');
      revision = change.body.revision;
    }
  }
  function connect() {
    if (closed) return;
    const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 65_536, handshakeTimeout: 15_000, perMessageDeflate: false });
    socket = ws;
    const abort = new AbortController(); activeAbort = abort;
    ws.on('error', () => {});
    ws.on('open', () => { void publish(abort.signal).catch(() => { if (!abort.signal.aborted) ws.close(); }); });
    ws.on('message', (raw) => {
      let request;
      try { request = JSON.parse(raw.toString()); } catch { ws.close(); return; }
      if (request.type !== 'request' || !allowedRoute(request.method, request.path) || typeof request.id !== 'string') { ws.close(); return; }
      if (pending.size >= 32) { send({ type: 'response', id: request.id, status: 429, body: { error: '电脑请求繁忙。' } }); return; }
      const identity = resolveIdentity();
      if (!identity) { send({ type: 'response', id: request.id, status: 503, body: { error: '电脑尚未完成本机配对。' } }); return; }
      const controller = new AbortController(); pending.add(controller);
      const requestId = request.id;
      void localRequest(identity, request.path, request.method, request.body, AbortSignal.any([controller.signal, abort.signal, AbortSignal.timeout(30_000)]))
        .then((result) => { if (socket === ws && !abort.signal.aborted) send({ type: 'response', id: requestId, ...result }); })
        .catch(() => { if (socket === ws && !abort.signal.aborted) send({ type: 'response', id: requestId, status: 504, body: { error: '本机回执未知，请查询状态。', error_code: 'delivery_unknown' } }); })
        .finally(() => pending.delete(controller));
      request = null;
    });
    ws.on('close', () => {
      abort.abort();
      if (!closed && socket === ws) retry = setTimeout(connect, retryMs);
    });
  }
  connect();
  return { close() { closed = true; clearTimeout(retry); activeAbort?.abort(); for (const controller of pending) controller.abort(); socket?.terminate(); } };
}

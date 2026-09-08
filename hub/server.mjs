import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { createChangeFeed } from '../relay/change-feed.mjs';
import { tryServeStatic } from '../relay/static-web.mjs';
import { allowedRoute, publicResult } from './protocol.mjs';

export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
function matches(token, hash) {
  if (typeof token !== 'string' || token.length < 32 || !/^[a-f0-9]{64}$/.test(hash ?? '')) return false;
  return timingSafeEqual(Buffer.from(tokenHash(token)), Buffer.from(hash));
}
function bearer(request) { return request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1]; }
function send(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}
async function body(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) throw new Error('body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

export function createHubServer({ getConfig, webRoot, rpcTimeoutMs = 30_000, heartbeatMs = 15_000, staleMs = 45_000 }) {
  const hosts = new Map();
  const changes = createChangeFeed();
  const wss = new WebSocket.Server({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
  const owner = (request) => matches(bearer(request), getConfig().ownerHash);
  const hostConfig = (id) => getConfig().agents.find((agent) => agent.id === id && !agent.revoked);
  const online = (entry) => Boolean(entry?.ws?.readyState === WebSocket.OPEN && entry.ready && Date.now() - entry.lastPong < staleMs && Date.now() - Date.parse(entry.seenAt) < staleMs);
  function disconnect(entry) {
    if (!entry) return;
    entry.ws?.terminate(); entry.ws = null;
    for (const pending of entry.pending.values()) pending.finish(503, { error: '电脑连接中断；请查询回执确认是否送达。', error_code: 'delivery_unknown' });
    entry.pending.clear(); changes.notify();
  }
  function snapshot(entry, id) {
    return { ...publicResult(entry.snapshot, id), hub_online: online(entry), hub_seen_at: entry.seenAt,
      status: { ...publicResult(entry.snapshot.status, id), push_configured: false, web_push_configured: false } };
  }
  function rpc(entry, request, response, path, payload) {
    if (entry.pending.size >= 32) { send(response, 429, { error: '电脑请求繁忙，请稍后重试。' }); return; }
    const id = randomUUID();
    const pending = { finish(status, result) { clearTimeout(timer); entry.pending.delete(id); send(response, status, result); } };
    const timer = setTimeout(() => pending.finish(504, { error: '电脑回执超时；请查询状态后再决定是否重发。', error_code: 'delivery_unknown' }), rpcTimeoutMs);
    entry.pending.set(id, pending);
    // No payload retained in the pending map, retry queue, logs, or disk.
    entry.ws.send(JSON.stringify({ type: 'request', id, method: request.method, path, body: payload }), (error) => {
      if (error) pending.finish(503, { error: '连接中断；投递结果未知。', error_code: 'delivery_unknown' });
    });
  }
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://hub.local');
      // No cross-origin API access. Tailscale Serve preserves the public Host.
      if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
        send(response, 403, { error: 'origin not allowed' }); return;
      }
      if (request.method === 'GET' && url.pathname === '/healthz') { send(response, 200, { service: 'codexy-hub', version: 1 }); return; }
      if (request.method === 'GET' && url.pathname === '/v1/hub/info') { send(response, 200, { hub: true }); return; }
      if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/h/')) {
        if (!owner(request)) { send(response, 401, { error: '请输入有效的中枢访问密钥。' }); return; }
        if (request.method === 'GET' && url.pathname === '/v1/hub/hosts') {
          send(response, 200, { hosts: getConfig().agents.filter((agent) => !agent.revoked).map(({ id, label }) => ({ id, label, online: online(hosts.get(id)) })) }); return;
        }
        if (request.method === 'GET' && url.pathname === '/v1/hub/changes') {
          changes.watch(request, response, url.searchParams.get('after'), () => owner(request), send); return;
        }
        const match = url.pathname.match(/^\/h\/([a-zA-Z0-9_-]{1,64})\/v1\/devices\/([a-zA-Z0-9_-]{1,64})(\/.*)?$/);
        if (!match || match[1] !== match[2] || !hostConfig(match[1])) { send(response, 404, { error: '设备不存在或已撤销。' }); return; }
        const [, id, , path = ''] = match;
        const entry = hosts.get(id);
        if (request.method === 'GET' && path === '/changes') {
          changes.watch(request, response, url.searchParams.get('after'), () => owner(request) && Boolean(hostConfig(id)), send); return;
        }
        if (request.method === 'GET' && path === '/snapshot' && entry?.snapshot) { send(response, 200, snapshot(entry, id)); return; }
        if (!allowedRoute(request.method, path)) { send(response, 403, { error: '中枢不提供此操作；设备接入请在电脑管理。' }); return; }
        if (!online(entry)) { send(response, 503, { error: '电脑未连接中枢，当前进度未知，指令尚未发送。', error_code: 'host_offline' }); return; }
        rpc(entry, request, response, path, ['POST', 'PATCH'].includes(request.method) ? await body(request) : undefined);
        return;
      }
      if (await tryServeStatic({ request, response, url, webRoot })) return;
      send(response, 404, { error: 'route not found' });
    } catch { send(response, 400, { error: '请求无效。' }); }
  });
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url, 'http://hub.local');
      const id = url.pathname.match(/^\/v1\/hub\/agents\/([a-zA-Z0-9_-]{1,64})$/)?.[1];
      const config = id && hostConfig(id);
      if (url.search || request.headers.origin || !config || !matches(bearer(request), config.tokenHash)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const old = hosts.get(id); disconnect(old);
        const entry = { ws, ready: false, tokenHash: config.tokenHash, pending: new Map(), lastPong: Date.now(), seenAt: old?.seenAt ?? null, snapshot: old?.snapshot ?? null };
        hosts.set(id, entry);
        ws.on('pong', () => { entry.lastPong = Date.now(); });
        ws.on('error', () => {});
        ws.on('close', () => { if (hosts.get(id) === entry) disconnect(entry); });
        ws.on('message', (raw) => {
          try {
            if (hosts.get(id) !== entry || hostConfig(id)?.tokenHash !== entry.tokenHash) { disconnect(entry); return; }
            const message = JSON.parse(raw.toString());
            if (message.type === 'snapshot' && message.snapshot?.status && Array.isArray(message.snapshot.sessions) && message.snapshot.sessions.length <= 128) {
              entry.snapshot = publicResult(message.snapshot, id); entry.seenAt = new Date().toISOString(); entry.ready = true; changes.notify();
            } else if (message.type === 'unavailable') {
              entry.snapshot = null; entry.seenAt = null; entry.ready = false; changes.notify();
            } else if (message.type === 'response' && Number.isInteger(message.status) && message.status >= 200 && message.status <= 599) {
              const result = publicResult(message.body, id);
              if (result?.device_id) { result.push_configured = false; result.web_push_configured = false; }
              entry.pending.get(message.id)?.finish(message.status, result);
            }
          } catch { disconnect(entry); }
        });
        changes.notify();
      });
    } catch { socket.destroy(); }
  });
  const timer = setInterval(() => {
    for (const [id, entry] of hosts) {
      if (!hostConfig(id) || hostConfig(id).tokenHash !== entry.tokenHash || Date.now() - entry.lastPong >= staleMs) {
        if (entry.ws) disconnect(entry);
      } else entry.ws.ping();
    }
  }, heartbeatMs);
  timer.unref();
  function close() { clearInterval(timer); for (const entry of hosts.values()) disconnect(entry); changes.close(); wss.close(); }
  server.on('close', close);
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configPath = process.env.CODEXY_HUB_CONFIG;
  if (!configPath) throw new Error('CODEXY_HUB_CONFIG is required');
  const getConfig = () => JSON.parse(readFileSync(configPath, 'utf8'));
  getConfig();
  const { server, close } = createHubServer({ getConfig, webRoot: process.env.CODEXY_WEB_ROOT });
  server.listen(Number(process.env.PORT ?? 8797), process.env.HOST ?? '127.0.0.1', () => console.log('Codexy Hub ready'));
  process.on('SIGTERM', () => { close(); server.close(); });
}

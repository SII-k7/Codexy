import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';

import { RemoteCommandError } from './remote-commands.mjs';
import { contextUsage, publicGoal, weeklyLimit, finiteNumber } from './session-tools.mjs';
import { summarizeLatestAgentReply } from './response-summary.mjs';

const DEFAULT_APP_SERVER_URL = 'ws://127.0.0.1:4510';
const RPC_TIMEOUT_MS = 15_000;
const INDEX_REFRESH_MS = 60_000;
const QUEUE_POLL_MS = 30_000;
const MODEL_CATALOG_TTL_MS = 60_000;

function publicString(value, fallback = '', maxLength = 160) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || fallback).slice(0, maxLength);
}

function publicIdentifier(value, fallback = '') {
  const identifier = publicString(value, fallback, 80);
  return /^[a-zA-Z0-9._:+-]{1,80}$/.test(identifier)
    ? identifier
    : fallback;
}

function publicRateLimitWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const usedPercent = finiteNumber(value.usedPercent);
  if (usedPercent === null) return null;
  return {
    used_percent: Number.isFinite(usedPercent)
      ? Math.max(0, Math.min(100, usedPercent))
      : 0,
    window_minutes: Number.isFinite(Number(value.windowDurationMins))
      ? Math.max(0, Number(value.windowDurationMins))
      : null,
    resets_at: Number.isFinite(Number(value.resetsAt))
      ? new Date(Number(value.resetsAt) * 1000).toISOString()
      : null,
  };
}

function publicModel(model) {
  const modelId = publicIdentifier(model?.model ?? model?.id);
  if (!modelId) return null;
  const efforts = [...new Set(
    (Array.isArray(model?.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts
      : []
    )
      .map((option) => publicIdentifier(option?.reasoningEffort))
      .filter(Boolean),
  )];
  const defaultEffort = publicIdentifier(model?.defaultReasoningEffort);
  return {
    id: modelId,
    display_name: publicString(model?.displayName, modelId, 64),
    description: publicString(model?.description, '', 180),
    is_default: model?.isDefault === true,
    supported_efforts: efforts,
    default_effort:
      efforts.includes(defaultEffort) ? defaultEffort : efforts[0] ?? null,
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireActiveCommand(command) {
  if (command.status === 'expired' || Date.now() >= command.expiresAtMs) {
    throw new RemoteCommandError('command_expired', '指令在发送前已过期。');
  }
  if (command.status === 'canceled' || !command.prompt) {
    throw new RemoteCommandError(
      'command_canceled',
      '这条指令已从手机撤回。',
      409,
    );
  }
}

function resolveCodexLaunch(command) {
  if (process.platform !== 'win32') {
    return { command, prefix: [], shell: false };
  }
  let commandPath = command;
  if (!/[\\/]/.test(commandPath)) {
    const located = spawnSync('where.exe', [commandPath], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const firstMatch = located.stdout
      ?.split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean);
    if (firstMatch) commandPath = firstMatch;
  }
  if (/\.cmd$/i.test(commandPath)) {
    const javascriptLauncher = resolve(
      dirname(commandPath),
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    );
    if (existsSync(javascriptLauncher)) {
      return {
        command: process.execPath,
        prefix: [javascriptLauncher],
        shell: false,
      };
    }
  }
  return {
    command: commandPath,
    prefix: [],
    shell: /\.cmd$/i.test(commandPath),
  };
}

export function sessionRefForThreadId(threadId) {
  const digest = createHash('sha256').update(threadId, 'utf8').digest('hex');
  return `sha256:${digest.slice(0, 24)}`;
}

export class AppServerRpc {
  constructor(url, onNotification = () => {}, onDisconnect = () => {}) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onNotification = onNotification;
    this.onDisconnect = onDisconnect;
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('app-server websocket timed out'));
      }, 2_000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('close', () => this.handleClose());
    socket.on('error', () => {
      // The close handler rejects outstanding RPC requests.
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'codexy',
        title: 'Codexy',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          'item/agentMessage/delta',
          'item/reasoning/textDelta',
          'item/reasoning/summaryTextDelta',
          'command/exec/outputDelta',
          'process/outputDelta',
        ],
      },
    });
    this.notify('initialized');
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    // Server requests have their own ID namespace; never mistake an approval
    // request for the reply to one of our RPCs. The TUI handles approvals.
    if (typeof message.method === 'string') {
      if (!Object.hasOwn(message, 'id')) this.onNotification(message.method, message.params);
      return;
    }
    if (!Object.hasOwn(message, 'id')) return;
    const pending = this.pending.get(String(message.id));
    if (!pending) {
      // Server-originated approval and user-input requests deliberately remain
      // unresolved here. The connected Codex TUI remains the approval surface.
      return;
    }
    this.pending.delete(String(message.id));
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new Error(
          typeof message.error.message === 'string'
            ? message.error.message
            : 'app-server request failed',
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pending.deliveryError ?? new Error('app-server websocket closed'));
    }
    this.pending.clear();
    this.onDisconnect();
  }

  request(method, params) {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.closed
    ) {
      return Promise.reject(new Error('app-server websocket is not open'));
    }
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const deliveryError = ['turn/start', 'turn/steer'].includes(method)
        ? new RemoteCommandError('delivery_unknown', '电脑连接中断，无法确认 Codex 是否已接收。请查看会话后再决定，勿直接重复发送。')
        : null;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(deliveryError ?? new Error(`${method} timed out`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, deliveryError });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method, params) {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.closed
    ) {
      return;
    }
    this.socket.send(
      JSON.stringify({
        method,
        ...(params === undefined ? {} : { params }),
      }),
    );
  }

  close() {
    this.closed = true;
    this.socket?.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pending.deliveryError ?? new Error('app-server client closed'));
    }
    this.pending.clear();
  }
}

function safeControlDetail(error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/only supported on Unix/i.test(detail)) {
    return 'Windows 需要由 Codexy 直接启动 App Server。';
  }
  return '无法连接本机 Codex App Server。';
}

export class CodexControlBridge {
  constructor(options = {}) {
    this.enabled = options.enabled ?? false;
    this.url = options.url ?? DEFAULT_APP_SERVER_URL;
    this.codexCommand = options.codexCommand ?? 'codex.cmd';
    this.spawnServer = options.spawnServer ?? true;
    this.state = this.enabled ? 'starting' : 'disabled';
    this.detail = this.enabled
      ? '正在连接本机 Codex App Server。'
      : '桌面端尚未启用远程控制。';
    this.rpc = null;
    this.child = null;
    this.threadIndex = new Map();
    this.indexUpdatedAt = 0;
    this.modelCatalog = [];
    this.modelCatalogLoadedAt = 0;
    this.contextBySession = new Map();
    this.rateCache = null;
    this.rateLoadedAt = 0;
    this.ratePromise = null;
    this.refreshTimer = null;
    this.startPromise = null;
    this.stopped = false;
    this.listeners = new Set();
    this.threadVersions = new Map();
    this.subscribed = new Set();
    this.refreshPromise = null;
    this.eventTimer = null;
    this.retryTimer = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(sessionRef = null) {
    for (const listener of this.listeners) listener(sessionRef);
  }

  scheduleRefresh() {
    if (this.stopped || this.eventTimer) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null;
      void this.refreshIndex(true).catch(() => this.recover());
    }, 100);
    this.eventTimer.unref?.();
  }

  handleNotification(method, params = {}) {
    if (method === 'account/rateLimits/updated') { this.rateLoadedAt = 0; this.changed(); return; }
    const id = params.threadId ?? params.thread?.id;
    if (typeof id !== 'string') return;
    const ref = sessionRefForThreadId(id);
    if (method === 'thread/tokenUsage/updated') {
      const usage = contextUsage(params.tokenUsage);
      if (usage) this.contextBySession.set(ref, usage); else this.contextBySession.delete(ref);
      this.changed(ref); return;
    }
    if (['thread/goal/updated', 'thread/goal/cleared', 'thread/settings/updated'].includes(method)) {
      if (method === 'thread/settings/updated') this.contextBySession.delete(ref);
      this.changed(ref); return;
    }
    let status;
    if (method === 'thread/status/changed') status = params.status;
    else if (method === 'thread/started') status = params.thread?.status;
    else if (method === 'thread/closed') status = { type: 'notLoaded' };
    else if (method === 'turn/started') status = { type: 'active', activeFlags: [] };
    else if (method === 'turn/completed') {
      // Read the authoritative status: completion can race another queued turn.
      this.scheduleRefresh();
      this.changed(ref);
      return;
    } else if (['thread/archived', 'thread/deleted'].includes(method)) {
      this.threadVersions.set(ref, (this.threadVersions.get(ref) ?? 0) + 1);
      this.threadIndex.delete(ref); this.subscribed.delete(ref); this.contextBySession.delete(ref);
      this.changed(ref); return;
    } else return; // Never retain item content, tool output or prompt text.
    if (!['active', 'idle', 'notLoaded', 'systemError'].includes(status?.type)) return;
    this.threadVersions.set(ref, (this.threadVersions.get(ref) ?? 0) + 1);
    const known = this.threadIndex.get(ref);
    this.threadIndex.set(ref, {
      id, ...known, status: { type: status.type, activeFlags: status.activeFlags ?? [] },
      updatedAt: Date.now() / 1000, observedAtMs: Date.now(),
    });
    if (status.type === 'notLoaded') this.subscribed.delete(ref);
    if (!known) this.scheduleRefresh();
    this.changed(ref);
  }

  waitForThreadChange(threadId, timeoutMs) {
    const ref = sessionRefForThreadId(threadId);
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); unsubscribe(); resolve(); };
      const unsubscribe = this.subscribe((changedRef) => {
        if (changedRef === null || changedRef === ref) finish();
      });
      const timer = setTimeout(finish, Math.max(1, timeoutMs));
    });
  }

  getStatus() {
    return {
      state: this.state,
      detail: this.detail,
      endpoint: this.enabled ? 'localhost-only' : null,
    };
  }

  statusForSession(sessionRef) {
    if (!this.enabled) return 'setup_required';
    if (this.state === 'starting') return 'checking';
    if (this.state === 'error') return 'error';
    const thread = this.threadIndex.get(sessionRef);
    if (
      !thread ||
      !['notLoaded', 'idle', 'active'].includes(thread.status?.type)
    ) {
      return 'observe_only';
    }
    return 'ready';
  }

  activityForSession(sessionRef) {
    if (this.state !== 'ready') return null;
    const thread = this.threadIndex.get(sessionRef);
    const observedAt = thread?.observedAtMs ?? this.indexUpdatedAt;
    if (Date.now() - observedAt > INDEX_REFRESH_MS + RPC_TIMEOUT_MS) return null;
    const status = thread?.status;
    if (!['active', 'idle', 'systemError'].includes(status?.type)) return null;
    return {
      type: status.type,
      needsInput: status.activeFlags?.some((flag) => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) ?? false,
      observedAt: new Date(observedAt).toISOString(),
      updatedAt: typeof thread.updatedAt === 'number' && Number.isFinite(thread.updatedAt)
        ? new Date(thread.updatedAt * 1000).toISOString() : null,
    };
  }

  async connectRpc() {
    const rpc = new AppServerRpc(this.url,
      (method, params) => { if (this.rpc === rpc) this.handleNotification(method, params); },
      () => { if (this.rpc === rpc) this.recover(); });
    try { await rpc.connect(); } catch (error) { rpc.close(); throw error; }
    return rpc;
  }

  startChild() {
    if (this.child || !this.spawnServer) return;
    const launch = resolveCodexLaunch(this.codexCommand);
    this.child = spawn(
      launch.command,
      [...launch.prefix, 'app-server', '--listen', this.url],
      {
        windowsHide: true,
        shell: launch.shell,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const log = (chunk) => {
      const message = chunk.toString('utf8').trim();
      if (message) console.log(`[codex app-server] ${message}`);
    };
    this.child.stdout?.on('data', log);
    this.child.stderr?.on('data', log);
    this.child.once('exit', (code) => {
      this.child = null;
      if (!this.stopped && this.state !== 'ready') {
        this.state = 'error';
        this.detail = `Codex App Server 已退出（${code ?? 'unknown'}）。`;
      }
    });
  }

  async connectWithRetry() {
    try {
      return await this.connectRpc();
    } catch (firstError) {
      if (!this.spawnServer) throw firstError;
      this.startChild();
      let lastError = firstError;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (this.stopped) throw new Error('app-server bridge stopped');
        await wait(250);
        try {
          return await this.connectRpc();
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    }
  }

  async start() {
    if (!this.enabled || this.stopped) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      this.state = 'starting';
      this.detail = '正在连接本机 Codex App Server。';
      try {
        this.rpc?.close();
        this.rpc = await this.connectWithRetry();
        if (this.stopped) { this.rpc.close(); this.rpc = null; return; }
        this.subscribed.clear();
        this.contextBySession.clear();
        this.rateLoadedAt = 0;
        this.state = 'ready';
        this.detail = '手机可向由 codexy 打开的 Codex 会话发送指令。';
        await this.refreshIndex(true);
        if (!this.refreshTimer) {
          this.refreshTimer = setInterval(
            () => this.state === 'ready'
              ? void this.refreshIndex(true).catch(() => this.recover()) : this.recover(),
            INDEX_REFRESH_MS,
          );
          this.refreshTimer.unref?.();
        }
      } catch (error) {
        this.state = 'error';
        this.detail = safeControlDetail(error);
        this.changed();
        if (!this.stopped && !this.retryTimer) {
          this.retryTimer = setTimeout(() => { this.retryTimer = null; this.recover(); }, 5000);
          this.retryTimer.unref?.();
        }
        throw error;
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  recover() {
    if (this.stopped || !this.enabled || this.state === 'starting') return;
    this.state = 'starting';
    this.detail = '正在重新连接本机 Codex App Server。';
    this.changed();
    void this.start().catch(() => {
      // Status is exposed to the phone; the next refresh will retry.
    });
  }

  async refreshIndex(subscribeLoaded = false) {
    if (!this.rpc || this.state !== 'ready') return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.reconcileIndex(subscribeLoaded);
    try { await this.refreshPromise; } finally { this.refreshPromise = null; }
  }

  async reconcileIndex(subscribeLoaded) {
    const rpc = this.rpc;
    const versions = new Map(this.threadVersions);
    const nextIndex = new Map();
    let cursor = null;
    do {
      const result = await rpc.request('thread/list', {
        cursor,
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        sourceKinds: ['cli', 'vscode', 'appServer'],
        archived: false,
      });
      for (const thread of result?.data ?? []) {
        if (typeof thread?.id !== 'string') continue;
        nextIndex.set(sessionRefForThreadId(thread.id), { ...thread, observedAtMs: Date.now() });
      }
      cursor = result?.nextCursor ?? null;
    } while (cursor && nextIndex.size < 500);
    if (this.rpc !== rpc || this.stopped) return;
    // Notifications received during an older list request win over that list.
    for (const [ref, version] of this.threadVersions) {
      if (version !== versions.get(ref)) {
        if (this.threadIndex.has(ref)) nextIndex.set(ref, this.threadIndex.get(ref));
        else nextIndex.delete(ref);
      }
    }
    this.threadIndex = nextIndex;
    this.indexUpdatedAt = Date.now();
    this.changed();
    if (!subscribeLoaded) return;
    // Resume only already-loaded threads, without turns or configuration
    // overrides, to subscribe this connection. Never load historical threads.
    for (const [ref, thread] of nextIndex) {
      if (!['idle', 'active'].includes(thread.status?.type) || this.subscribed.has(ref)) continue;
      try {
        await rpc.request('thread/resume', { threadId: thread.id, excludeTurns: true });
        if (this.rpc !== rpc || this.stopped) return;
        this.subscribed.add(ref);
      } catch { /* Older servers can still use low-frequency reconciliation. */ }
    }
  }

  async ensureReady() {
    if (!this.enabled) {
      throw new RemoteCommandError(
        'control_not_configured',
        '电脑端尚未启用 Codex 控制桥接。',
        503,
      );
    }
    if (this.state !== 'ready' || !this.rpc) {
      await this.start().catch(() => {});
    }
    if (this.state !== 'ready' || !this.rpc) {
      throw new RemoteCommandError(
        'control_offline',
        '电脑端 Codex 控制桥接当前离线。',
        503,
      );
    }
  }

  async threadForSession(sessionRef) {
    await this.ensureReady();
    if (!this.threadIndex.has(sessionRef) || Date.now() - this.indexUpdatedAt >= INDEX_REFRESH_MS) await this.refreshIndex();
    const thread = this.threadIndex.get(sessionRef);
    if (!thread) {
      throw new RemoteCommandError(
        'session_not_found',
        'App Server 中找不到这个会话，请在电脑端用 codexy 打开它。',
      );
    }
    if (
      !['notLoaded', 'idle', 'active'].includes(thread.status?.type)
    ) {
      throw new RemoteCommandError(
        'session_observe_only',
        '这个会话目前只能观察；请用 codexy 恢复或重新打开后再操作。',
      );
    }
    return thread;
  }

  async readThread(threadId, includeTurns = false) {
    try {
      const result = await this.rpc.request('thread/read', { threadId, includeTurns });
      return result.thread;
    } catch (error) {
      if (!includeTurns || !/paginated threads do not support thread\/read/i.test(error?.message ?? '')) throw error;
      // New paginated stores reject inline history. Read only recent turns,
      // without resuming or modifying the conversation. Keep chronological
      // order for the summary and active-turn consumers used by older stores.
      const metadata = await this.rpc.request('thread/read', { threadId, includeTurns: false });
      const page = await this.rpc.request('thread/turns/list', {
        threadId, limit: 10, sortDirection: 'desc', itemsView: 'full',
      });
      return { ...metadata.thread, turns: [...(page.data ?? [])].reverse() };
    }
  }

  async resumeThread(thread) {
    const result = await this.rpc.request('thread/resume', {
      threadId: thread.id,
      excludeTurns: true,
    });
    const resumed = result?.thread;
    if (
      !resumed ||
      resumed.canAcceptDirectInput !== true ||
      !['idle', 'active'].includes(resumed.status?.type)
    ) {
      throw new RemoteCommandError(
        'session_observe_only',
        '这个会话目前只能观察；请用 codexy 恢复或重新打开后再操作。',
      );
    }
    this.threadIndex.set(sessionRefForThreadId(resumed.id), resumed);
    return result;
  }

  async resumeForDirectInput(thread) {
    if (thread.canAcceptDirectInput === true) return thread;
    if (!['notLoaded', 'idle', 'active'].includes(thread.status?.type)) {
      throw new RemoteCommandError(
        'session_observe_only',
        '这个会话目前只能观察；请用 codexy 恢复或重新打开后再发送。',
      );
    }
    return (await this.resumeThread(thread)).thread;
  }

  async listModels(force = false) {
    const cacheFresh =
      this.modelCatalog.length > 0 &&
      Date.now() - this.modelCatalogLoadedAt < MODEL_CATALOG_TTL_MS;
    if (!force && cacheFresh) return this.modelCatalog;

    const models = [];
    let cursor = null;
    do {
      const result = await this.rpc.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      for (const item of result?.data ?? []) {
        if (item?.hidden === true) continue;
        const model = publicModel(item);
        if (model) models.push(model);
      }
      cursor = result?.nextCursor ?? null;
    } while (cursor && models.length < 200);

    this.modelCatalog = models;
    this.modelCatalogLoadedAt = Date.now();
    return models;
  }

  async readPublicRateLimit() {
    if (Date.now() - this.rateLoadedAt < 60_000) return this.rateCache;
    if (this.ratePromise) return this.ratePromise;
    this.ratePromise = this.fetchPublicRateLimit();
    try { this.rateCache = await this.ratePromise; this.rateLoadedAt = Date.now(); return this.rateCache; }
    finally { this.ratePromise = null; }
  }

  async fetchPublicRateLimit() {
    try {
      const result = await this.rpc.request('account/rateLimits/read');
      const snapshot =
        result?.rateLimitsByLimitId?.codex ?? result?.rateLimits ?? null;
      if (!snapshot) return null;
      return {
        primary: publicRateLimitWindow(snapshot.primary),
        secondary: publicRateLimitWindow(snapshot.secondary),
      };
    } catch {
      return null;
    }
  }

  async getSessionRuntime(sessionRef) {
    const thread = await this.threadForSession(sessionRef);
    const [rate, result] = await Promise.all([
      this.readPublicRateLimit(),
      this.rpc.request('thread/goal/get', { threadId: thread.id }).then(value => ({ available: true, goal: publicGoal(value?.goal) })).catch(() => ({ available: false, goal: null })),
    ]);
    return { session_ref: sessionRef, context: this.contextBySession.get(sessionRef) ?? null,
      weekly: weeklyLimit(rate), goal_available: result.available, goal: result.goal,
      refreshed_at: new Date().toISOString() };
  }

  async updateSessionGoal(sessionRef, input) {
    let thread = await this.threadForSession(sessionRef);
    // Claim only the selected conversation, and only after explicit user action.
    thread = await this.resumeForDirectInput(thread);
    const params = { threadId: thread.id, status: input.action === 'pause' ? 'paused' : 'active' };
    if (input.action === 'set') {
      params.objective = input.objective;
      if (input.tokenBudget !== undefined) params.tokenBudget = input.tokenBudget;
    }
    if (input.action !== 'set') {
      const current = await this.rpc.request('thread/goal/get', { threadId: thread.id });
      if (!current?.goal) throw new RemoteCommandError('goal_missing', '该会话还没有 Goal。', 409);
    }
    const result = await this.rpc.request('thread/goal/set', params);
    this.changed(sessionRef);
    return { goal: publicGoal(result?.goal) };
  }

  async buildControlSnapshot(sessionRef, resumed, models) {
    const state = publicIdentifier(resumed?.thread?.status?.type, 'idle');
    const currentModel = publicIdentifier(resumed?.model);
    const currentEffort =
      publicIdentifier(resumed?.reasoningEffort) ||
      models.find((model) => model.id === currentModel)?.default_effort ||
      null;
    const permissionId = publicIdentifier(
      resumed?.activePermissionProfile?.id,
      'custom',
    ).replace(/^:/, '');
    const approvalPolicy =
      typeof resumed?.approvalPolicy === 'string'
        ? publicIdentifier(resumed.approvalPolicy, 'custom')
        : 'custom';
    return {
      session_ref: sessionRef,
      control_status: 'ready',
      session_state: state,
      model: currentModel,
      reasoning_effort: currentEffort,
      approval_policy: approvalPolicy,
      permission_profile: permissionId,
      settings_apply_to: 'subsequent_turns',
      models,
      rate_limit: await this.readPublicRateLimit(),
      available_actions: {
        status: true,
        compact: state === 'idle',
        review: state === 'idle',
        interrupt: state === 'active',
      },
      refreshed_at: new Date().toISOString(),
    };
  }

  async getSessionControl(sessionRef) {
    const thread = await this.threadForSession(sessionRef);
    const resumed = await this.resumeThread(thread);
    const models = await this.listModels();
    return this.buildControlSnapshot(sessionRef, resumed, models);
  }

  async getSessionResponseSummary(sessionRef) {
    const thread = await this.threadForSession(sessionRef);
    const storedThread = await this.readThread(thread.id, true);
    return summarizeLatestAgentReply(sessionRef, storedThread);
  }

  async updateSessionSettings(sessionRef, input = {}) {
    const current = await this.getSessionControl(sessionRef);
    const modelId = publicIdentifier(input.model, current.model);
    const model = current.models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new RemoteCommandError(
        'invalid_model',
        '这个模型不在当前 Codex 账户的可用目录中。',
        400,
      );
    }
    const requestedEffort = publicIdentifier(
      input.reasoningEffort,
      current.reasoning_effort ?? model.default_effort,
    );
    if (input.reasoningEffort && !model.supported_efforts.includes(requestedEffort)) {
      throw new RemoteCommandError('invalid_reasoning_effort', '所选模型不支持这个思考强度。', 400);
    }
    const effort = model.supported_efforts.includes(requestedEffort)
      ? requestedEffort
      : model.default_effort;
    if (!effort) {
      throw new RemoteCommandError(
        'invalid_reasoning_effort',
        '这个模型没有可用的思考强度。',
        400,
      );
    }

    const thread = this.threadIndex.get(sessionRef);
    if (!thread) {
      throw new RemoteCommandError(
        'session_not_found',
        'App Server 中找不到这个会话。',
      );
    }
    await this.rpc.request('thread/settings/update', {
      threadId: thread.id,
      model: model.id,
      effort,
    });
    this.contextBySession.delete(sessionRef);
    this.changed(sessionRef);
    return this.getSessionControl(sessionRef);
  }

  async runSessionAction(sessionRef, action) {
    if (action === 'status') {
      return {
        action,
        accepted: true,
        detail: '实时状态已刷新。',
        snapshot: await this.getSessionControl(sessionRef),
      };
    }

    const before = await this.getSessionControl(sessionRef);
    const thread = this.threadIndex.get(sessionRef);
    if (!thread) {
      throw new RemoteCommandError(
        'session_not_found',
        'App Server 中找不到这个会话。',
      );
    }

    let detail;
    if (action === 'compact') {
      if (before.session_state !== 'idle') {
        throw new RemoteCommandError(
          'session_busy',
          '当前回合结束后才能压缩上下文。',
        );
      }
      await this.rpc.request('thread/compact/start', {
        threadId: thread.id,
      });
      detail = '已开始压缩上下文；完成后可继续下一轮。';
    } else if (action === 'review') {
      if (before.session_state !== 'idle') {
        throw new RemoteCommandError(
          'session_busy',
          '当前回合结束后才能开始代码审查。',
        );
      }
      await this.rpc.request('review/start', {
        threadId: thread.id,
        target: { type: 'uncommittedChanges' },
        delivery: 'inline',
      });
      detail = '已开始审查未提交改动。';
    } else if (action === 'interrupt') {
      if (before.session_state !== 'active') {
        throw new RemoteCommandError(
          'no_active_turn',
          '当前没有正在运行的回合。',
        );
      }
      const activeThread = await this.readThread(thread.id, true);
      const activeTurn = [...(activeThread?.turns ?? [])]
        .reverse()
        .find((turn) => turn.status === 'inProgress');
      if (!activeTurn) {
        throw new RemoteCommandError(
          'no_active_turn',
          '当前没有可停止的运行中回合。',
        );
      }
      await this.rpc.request('turn/interrupt', {
        threadId: thread.id,
        turnId: activeTurn.id,
      });
      detail = '已请求停止当前回合。';
    } else {
      throw new RemoteCommandError(
        'invalid_control_action',
        '不支持这个 Codex 控制动作。',
        400,
      );
    }

    let snapshot = before;
    try {
      snapshot = await this.getSessionControl(sessionRef);
    } catch {
      // The accepted action remains truthful even if the immediate refresh races.
    }
    return {
      action,
      accepted: true,
      detail,
      snapshot,
    };
  }

  async dispatch(command, onStatus) {
    requireActiveCommand(command);
    let thread = await this.threadForSession(command.sessionRef);
    // Delivery checks this thread's current metadata, even when the overview
    // cache is fresh. A missed notification must not bypass Queue semantics.
    if (thread.canAcceptDirectInput === true) thread = await this.readThread(thread.id, false);
    thread = await this.resumeForDirectInput(thread);
    if (!['idle', 'active'].includes(thread.status?.type)) {
      throw new RemoteCommandError(
        'session_observe_only',
        '这个会话目前只能观察；请用 codexy 恢复或重新打开后再发送。',
      );
    }

    if (command.mode === 'queue') {
      while (thread.status?.type === 'active') {
        requireActiveCommand(command);
        if (Date.now() >= command.expiresAtMs) {
          throw new RemoteCommandError(
            'command_expired',
            '等待当前回合结束时指令已过期。',
          );
        }
        onStatus?.('waiting', '当前回合仍在工作，指令会在结束后发送。');
        await this.waitForThreadChange(thread.id, Math.min(QUEUE_POLL_MS, command.expiresAtMs - Date.now()));
        requireActiveCommand(command);
        await this.ensureReady();
        thread = await this.readThread(thread.id, false);
      }
      if (thread.status?.type !== 'idle') {
        throw new RemoteCommandError(
          'session_not_idle',
          '这个会话当前不能接收新指令。',
        );
      }
      requireActiveCommand(command);
      onStatus?.('dispatching', '正在开始下一轮 Codex 工作。');
      const result = await this.rpc.request('turn/start', {
        threadId: thread.id,
        clientUserMessageId: command.commandId,
        input: [
          {
            type: 'text',
            text: command.prompt,
            text_elements: [],
          },
        ],
        responsesapiClientMetadata: {
          codexy_command_id: command.commandId,
          codexy_mode: 'queue',
        },
      });
      return { turnId: result?.turn?.id ?? null };
    }

    requireActiveCommand(command);
    thread = await this.readThread(thread.id, true);
    const activeTurn = [...(thread.turns ?? [])]
      .reverse()
      .find((turn) => turn.status === 'inProgress');
    if (thread.status?.type !== 'active' || !activeTurn) {
      throw new RemoteCommandError(
        'no_active_turn',
        '当前没有可插入的运行中回合，请改用“排队发送”。',
      );
    }
    requireActiveCommand(command);
    onStatus?.('dispatching', '正在插入当前 Codex 回合。');
    const result = await this.rpc.request('turn/steer', {
      threadId: thread.id,
      expectedTurnId: activeTurn.id,
      clientUserMessageId: command.commandId,
      input: [
        {
          type: 'text',
          text: command.prompt,
          text_elements: [],
        },
      ],
      responsesapiClientMetadata: {
        codexy_command_id: command.commandId,
        codexy_mode: 'steer',
      },
    });
    return { turnId: result?.turnId ?? activeTurn.id };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.eventTimer); clearTimeout(this.retryTimer);
    this.changed(); this.listeners.clear();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.rpc?.close();
    this.rpc = null;
    if (this.child) {
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      if (process.platform === 'win32' && this.child.pid) {
        spawnSync(
          'taskkill.exe',
          ['/pid', String(this.child.pid), '/t', '/f'],
          {
            windowsHide: true,
            stdio: 'ignore',
          },
        );
      } else {
        this.child.kill();
      }
      this.child = null;
    }
  }
}

export function createCodexControlFromEnvironment() {
  const enabled = /^(1|true|yes)$/i.test(
    process.env.CODEXY_CODEX_CONTROL ??
      process.env.ATTENTION_CODEX_CONTROL ??
      '',
  );
  return new CodexControlBridge({
    enabled,
    url:
      process.env.CODEXY_CODEX_APP_SERVER_URL ??
      process.env.ATTENTION_CODEX_APP_SERVER_URL ??
      DEFAULT_APP_SERVER_URL,
    codexCommand:
      process.env.CODEXY_CODEX_COMMAND ??
      process.env.ATTENTION_CODEX_COMMAND ??
      (process.platform === 'win32' ? 'codex.cmd' : 'codex'),
    spawnServer: true,
  });
}

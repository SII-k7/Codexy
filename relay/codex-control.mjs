import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';

import { RemoteCommandError } from './remote-commands.mjs';
import { summarizeLatestAgentReply } from './response-summary.mjs';

const DEFAULT_APP_SERVER_URL = 'ws://127.0.0.1:4510';
const RPC_TIMEOUT_MS = 15_000;
const INDEX_REFRESH_MS = 2_500;
const QUEUE_POLL_MS = 1_000;
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
  const usedPercent = Number(value.usedPercent);
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

class AppServerRpc {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
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
      pending.reject(new Error('app-server websocket closed'));
    }
    this.pending.clear();
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
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
      pending.reject(new Error('app-server client closed'));
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
    this.modelCatalog = [];
    this.modelCatalogLoadedAt = 0;
    this.refreshTimer = null;
    this.startPromise = null;
    this.stopped = false;
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

  async connectRpc() {
    const rpc = new AppServerRpc(this.url);
    await rpc.connect();
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
        this.state = 'ready';
        this.detail = '手机可向由 codexy 打开的 Codex 会话发送指令。';
        await this.refreshIndex();
        if (!this.refreshTimer) {
          this.refreshTimer = setInterval(
            () => void this.refreshIndex().catch(() => this.recover()),
            INDEX_REFRESH_MS,
          );
          this.refreshTimer.unref?.();
        }
      } catch (error) {
        this.state = 'error';
        this.detail = safeControlDetail(error);
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
    void this.start().catch(() => {
      // Status is exposed to the phone; the next refresh will retry.
    });
  }

  async refreshIndex() {
    if (!this.rpc || this.state !== 'ready') return;
    const nextIndex = new Map();
    let cursor = null;
    do {
      const result = await this.rpc.request('thread/list', {
        cursor,
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        sourceKinds: ['cli', 'vscode', 'appServer'],
        archived: false,
      });
      for (const thread of result?.data ?? []) {
        if (typeof thread?.id !== 'string') continue;
        nextIndex.set(sessionRefForThreadId(thread.id), thread);
      }
      cursor = result?.nextCursor ?? null;
    } while (cursor && nextIndex.size < 500);
    this.threadIndex = nextIndex;
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
    await this.refreshIndex();
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
    const result = await this.rpc.request('thread/read', {
      threadId,
      includeTurns,
    });
    return result.thread;
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
    let thread = await this.threadForSession(command.sessionRef);
    thread = await this.resumeForDirectInput(thread);
    if (!['idle', 'active'].includes(thread.status?.type)) {
      throw new RemoteCommandError(
        'session_observe_only',
        '这个会话目前只能观察；请用 codexy 恢复或重新打开后再发送。',
      );
    }

    if (command.mode === 'queue') {
      while (thread.status?.type === 'active') {
        if (Date.now() >= command.expiresAtMs) {
          throw new RemoteCommandError(
            'command_expired',
            '等待当前回合结束时指令已过期。',
          );
        }
        onStatus?.('waiting', '当前回合仍在工作，指令会在结束后发送。');
        await wait(QUEUE_POLL_MS);
        thread = await this.readThread(thread.id, false);
      }
      if (thread.status?.type !== 'idle') {
        throw new RemoteCommandError(
          'session_not_idle',
          '这个会话当前不能接收新指令。',
        );
      }
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

import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
const MAX_COMMANDS_PER_DEVICE = 40;
const FINAL_STATUSES = new Set([
  'sent',
  'failed',
  'canceled',
  'expired',
]);

export class RemoteCommandError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'RemoteCommandError';
    this.code = code;
    this.status = status;
  }
}

function publicCommand(command) {
  return {
    command_id: command.commandId,
    session_ref: command.sessionRef,
    mode: command.mode,
    status: command.status,
    status_detail: command.statusDetail,
    created_at: command.createdAt,
    expires_at: command.expiresAt,
    updated_at: command.updatedAt,
    prompt_length: command.promptLength,
    ...(command.turnId ? { turn_id: command.turnId } : {}),
    ...(command.errorCode ? { error_code: command.errorCode } : {}),
  };
}

function safeFailure(error) {
  if (error instanceof RemoteCommandError) {
    return {
      code: error.code,
      detail: error.message,
    };
  }
  return {
    code: 'desktop_bridge_error',
    detail: '桌面桥接未能发送这条指令，请检查电脑端连接。',
  };
}

export function createRemoteCommandManager(options = {}) {
  const dispatch = options.dispatch;
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const commands = new Map();
  const commandsByDevice = new Map();
  const idempotency = new Map();
  let closed = false;

  function prune() {
    const cutoff = now() - retentionMs;
    for (const [commandId, command] of commands) {
      if (
        FINAL_STATUSES.has(command.status) &&
        Date.parse(command.updatedAt) < cutoff
      ) {
        commands.delete(commandId);
        const deviceCommands = commandsByDevice.get(command.deviceId) ?? [];
        commandsByDevice.set(
          command.deviceId,
          deviceCommands.filter((candidate) => candidate !== commandId),
        );
        idempotency.delete(
          `${command.deviceId}:${command.idempotencyKey}`,
        );
      }
    }
  }

  function setStatus(command, status, detail) {
    if (FINAL_STATUSES.has(command.status)) return;
    command.status = status;
    command.statusDetail = detail;
    command.updatedAt = new Date(now()).toISOString();
  }

  async function processCommand(command) {
    if (closed || FINAL_STATUSES.has(command.status)) return;
    if (now() >= command.expiresAtMs) {
      setStatus(command, 'expired', '指令在发送前已过期。');
      command.prompt = '';
      return;
    }

    setStatus(command, 'dispatching', '正在交给电脑端 Codex。');
    try {
      if (typeof dispatch !== 'function') {
        throw new RemoteCommandError(
          'control_not_configured',
          '电脑端尚未启用 Codex 控制桥接。',
          503,
        );
      }
      const result = await dispatch(command, (status, detail) => {
        if (FINAL_STATUSES.has(command.status)) return;
        setStatus(command, status, detail);
      });
      if (command.status === 'canceled') return;
      if (now() >= command.expiresAtMs) {
        setStatus(command, 'expired', '指令在发送前已过期。');
        return;
      }
      command.turnId = result?.turnId ?? null;
      setStatus(
        command,
        'sent',
        command.mode === 'steer'
          ? '已插入当前回合。'
          : '已发送为下一轮指令。',
      );
    } catch (error) {
      if (command.status === 'canceled') return;
      const failure = safeFailure(error);
      command.errorCode = failure.code;
      setStatus(command, 'failed', failure.detail);
    } finally {
      // Exact remote input is intentionally memory-only and is erased as soon
      // as dispatch reaches a terminal state.
      command.prompt = '';
    }
  }

  function enqueue(input) {
    if (closed) {
      throw new RemoteCommandError(
        'command_manager_closed',
        '远程指令服务正在关闭。',
        503,
      );
    }
    prune();

    const idempotencyKey = `${input.deviceId}:${input.idempotencyKey}`;
    const existingId = idempotency.get(idempotencyKey);
    if (existingId) {
      const existing = commands.get(existingId);
      if (existing) return publicCommand(existing);
    }

    const deviceCommands = commandsByDevice.get(input.deviceId) ?? [];
    const activeCount = deviceCommands
      .map((commandId) => commands.get(commandId))
      .filter(
        (command) => command && !FINAL_STATUSES.has(command.status),
      ).length;
    if (activeCount >= MAX_COMMANDS_PER_DEVICE) {
      throw new RemoteCommandError(
        'too_many_pending_commands',
        '待发送指令过多，请先等待已有指令完成。',
        429,
      );
    }

    const createdAtMs = now();
    const command = {
      commandId: randomUUID(),
      deviceId: input.deviceId,
      sessionRef: input.sessionRef,
      mode: input.mode,
      prompt: input.prompt,
      promptLength: input.prompt.length,
      idempotencyKey: input.idempotencyKey,
      status: 'queued',
      statusDetail: '已进入本机内存队列。',
      createdAt: new Date(createdAtMs).toISOString(),
      updatedAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + ttlMs).toISOString(),
      expiresAtMs: createdAtMs + ttlMs,
      turnId: null,
      errorCode: null,
    };
    commands.set(command.commandId, command);
    commandsByDevice.set(
      input.deviceId,
      [...deviceCommands, command.commandId].slice(-MAX_COMMANDS_PER_DEVICE),
    );
    idempotency.set(idempotencyKey, command.commandId);
    queueMicrotask(() => void processCommand(command));
    return publicCommand(command);
  }

  function list(deviceId) {
    prune();
    return (commandsByDevice.get(deviceId) ?? [])
      .map((commandId) => commands.get(commandId))
      .filter(Boolean)
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      )
      .map(publicCommand);
  }

  function get(deviceId, commandId) {
    prune();
    const command = commands.get(commandId);
    return command?.deviceId === deviceId ? publicCommand(command) : null;
  }

  function cancel(deviceId, commandId) {
    const command = commands.get(commandId);
    if (!command || command.deviceId !== deviceId) return null;
    if (!FINAL_STATUSES.has(command.status)) {
      setStatus(command, 'canceled', '已在送达 Codex 前取消。');
      command.prompt = '';
    }
    return publicCommand(command);
  }

  function close() {
    closed = true;
    for (const command of commands.values()) {
      if (!FINAL_STATUSES.has(command.status)) {
        setStatus(command, 'canceled', '桌面服务已关闭。');
      }
      command.prompt = '';
    }
  }

  return { cancel, close, enqueue, get, list };
}

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { tryServeStatic } from './static-web.mjs';
import { loadRelayStore, persistRelayStore } from './store.mjs';
import { createWebPushSender, normalizeVapidConfig } from './web-push.mjs';
import {
  DEFAULT_DEVICE_PREFERENCES,
  NOTIFICATION_LEVELS,
  NOTIFICATION_TONES,
  normalizeDevicePreferences,
  notificationForEvent,
  shouldNotifyForLevel,
} from './notifications.mjs';
import { createCodexControlFromEnvironment } from './codex-control.mjs';
import {
  RemoteCommandError,
  createRemoteCommandManager,
} from './remote-commands.mjs';
import { sanitizeAgentReply } from './response-summary.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS_PER_DEVICE = 100;
const MAX_WEB_PUSH_SUBSCRIPTIONS = 8;
const MAX_AGENT_SESSIONS = 16;
const MAX_PROMPTS_PER_SESSION = 10;
const PROMPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_REMOTE_PROMPT_LENGTH = 4_000;
const MAX_CONTROL_REQUESTS = 100;
const CONTROL_REQUEST_RETENTION_MS = 10 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_REGISTRATION_LIMIT = 20;
const DEFAULT_PAIRING_CLAIM_LIMIT = 10;
const CONTROL_ACTIONS = new Set([
  'status',
  'compact',
  'review',
  'interrupt',
]);
const ALLOWED_STATES = new Set([
  'working',
  'needs_you',
  'turn_finished',
  'subtask_completed',
  'completed',
  'failed',
  'interrupted',
  'background_ended',
  'session_ended',
]);
const ALLOWED_SOURCES = new Set(['codex']);

class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function text(value, fallback = '', max = 160) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || fallback).slice(0, max);
}

function secureToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function safeEqual(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function bearerToken(request) {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim() || null;
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  const corsOrigin = response.codexyCorsOrigin;
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'DELETE, GET, POST, PATCH, OPTIONS',
    ...(corsOrigin
      ? {
          'Access-Control-Allow-Origin': corsOrigin,
          Vary: 'Origin',
        }
      : {}),
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function configuredOrigins(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  return new Set(
    values.flatMap((item) => {
      try {
        return [new URL(item).origin];
      } catch {
        return [];
      }
    }),
  );
}

function allowedCorsOrigin(request, allowlist) {
  const origin = request.headers.origin;
  if (!origin) return null;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  const requestHosts = [
    request.headers.host,
    request.headers['x-forwarded-host'],
  ]
    .filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase());
  if (requestHosts.includes(parsed.host.toLowerCase())) {
    return parsed.origin;
  }
  return allowlist.has(parsed.origin) ? parsed.origin : null;
}

function isLocalManagementRequest(request) {
  const host = request.headers.host;
  if (typeof host !== 'string' || request.headers.origin) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
    return ['127.0.0.1', '::1', 'localhost'].includes(hostname);
  } catch {
    return false;
  }
}

function rateLimitKey(request) {
  return `${request.socket.remoteAddress ?? 'unknown'}:${
    request.headers['user-agent'] ?? 'unknown'
  }`;
}

function createAttemptLimiter(options = {}) {
  const limit = options.limit;
  const windowMs = options.windowMs;
  const now = options.now ?? (() => Date.now());
  const attempts = new Map();
  return {
    take(key) {
      const timestamp = now();
      const current = attempts.get(key);
      if (!current || timestamp >= current.resetAt) {
        attempts.set(key, { count: 1, resetAt: timestamp + windowMs });
        return true;
      }
      if (current.count >= limit) return false;
      current.count += 1;
      return true;
    },
  };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'request body is too large');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'request body must be one JSON object');
  }
}

function validateDeviceId(value) {
  const deviceId = text(value, '', 128);
  if (!/^[a-zA-Z0-9._:-]{6,128}$/.test(deviceId)) {
    throw new HttpError(400, 'device_id is invalid');
  }
  return deviceId;
}

function createPairingCode(store) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (![...store.devices.values()].some((item) => item.pairingCode === candidate)) {
      return candidate;
    }
  }
  throw new HttpError(503, 'could not allocate a pairing code');
}

function requireDevice(store, deviceId, request) {
  const device = store.devices.get(deviceId);
  if (!device) throw new HttpError(404, 'device is not registered');
  if (!safeEqual(bearerToken(request), device.deviceSecret)) {
    throw new HttpError(401, 'invalid device credential');
  }
  return device;
}

function requirePairedDevice(store, request) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, 'relay token is required');
  const deviceId = store.hookTokens.get(token);
  if (!deviceId) throw new HttpError(401, 'invalid relay token');
  const device = store.devices.get(deviceId);
  if (!device) throw new HttpError(401, 'paired device is unavailable');
  return device;
}

async function sendExpoPush(expoPushToken, event, preferences = {}) {
  if (!expoPushToken) return { status: 'not_configured' };
  const notification = notificationForEvent(event, preferences);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: expoPushToken,
        channelId: 'codex-events',
        title: notification.title,
        body: notification.body,
        data: notification.data,
        priority: event.state === 'needs_you' ? 'high' : 'default',
        ttl: 300,
      }),
    });
    if (!response.ok) {
      return { status: 'failed', detail: `HTTP ${response.status}` };
    }
    const payload = await response.json().catch(() => ({}));
    const ticket = Array.isArray(payload?.data)
      ? payload.data[0]
      : payload?.data;
    if (ticket?.status === 'error') {
      const code = text(ticket?.details?.error, '', 80);
      return {
        status: code === 'DeviceNotRegistered' ? 'expired' : 'failed',
        detail: text(ticket?.message, 'Expo rejected the push ticket', 160),
      };
    }
    return {
      status: 'sent',
      ...(typeof ticket?.id === 'string'
        ? { ticket_id: text(ticket.id, '', 128) }
        : {}),
    };
  } catch (error) {
    return {
      status: 'failed',
      detail: error instanceof Error ? error.message : 'push failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeEvent(body) {
  const state = text(body.state, '', 40);
  const source = text(body.source, '', 40);
  if (!ALLOWED_STATES.has(state)) {
    throw new HttpError(400, 'event state is invalid');
  }
  if (!ALLOWED_SOURCES.has(source)) {
    throw new HttpError(400, 'event source is invalid');
  }

  const eventId = text(body.event_id, '', 128);
  const dedupeKey = text(body.dedupe_key, '', 128);
  if (!eventId || !dedupeKey) {
    throw new HttpError(400, 'event_id and dedupe_key are required');
  }
  const sessionRef =
    typeof body.session_ref === 'string'
      ? text(body.session_ref, '', 80).toLowerCase()
      : '';
  if (sessionRef && !/^sha256:[a-f0-9]{16,64}$/.test(sessionRef)) {
    throw new HttpError(400, 'session_ref is invalid');
  }

  return {
    schema_version: '1.0',
    event_id: eventId,
    dedupe_key: dedupeKey,
    occurred_at: normalizedInputTimestamp(body.occurred_at),
    source,
    state,
    event: text(body.event, 'Manual', 80),
    project_alias: text(body.project_alias, 'Codex project', 64),
    summary: text(body.summary, 'Codex status changed', 160),
    ...(sessionRef ? { session_ref: sessionRef } : {}),
  };
}

function updateDevicePreferences(current, body) {
  const next = { ...normalizeDevicePreferences(current) };
  if ('notification_tone' in body) {
    if (!NOTIFICATION_TONES.has(body.notification_tone)) {
      throw new HttpError(400, 'notification_tone is invalid');
    }
    next.notification_tone = body.notification_tone;
  }
  if ('notification_level' in body) {
    if (!NOTIFICATION_LEVELS.has(body.notification_level)) {
      throw new HttpError(400, 'notification_level is invalid');
    }
    next.notification_level = body.notification_level;
  }
  return next;
}

function sanitizePrompt(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/```[\s\S]*?```/g, ' [code omitted] ')
    .replace(
      /\b(?:bearer\s+)?(?:sk-[a-z0-9_-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+|eyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{8,})/gi,
      '[redacted]',
    )
    .replace(/\bhttps?:\/\/\S+/gi, '[link]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(
      /(?<!\w)[A-Za-z]:[\\/](?:[^\s<>:"|?*,，。；;\[\](){}]+[\\/])*[^\s<>:"|?*,，。；;\[\](){}]*/g,
      '[path]',
    )
    .replace(
      /(?<!\w)\/(?:[^/\s,，。；;\[\](){}]+\/)+[^/\s,，。；;\[\](){}]*/g,
      '[path]',
    )
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2_000);
}

function normalizePromptCapture(body) {
  const sessionRef = text(body.session_ref, '', 80).toLowerCase();
  if (!/^sha256:[a-f0-9]{16,64}$/.test(sessionRef)) {
    throw new HttpError(400, 'session_ref is invalid');
  }
  const source = text(body.source, '', 40);
  if (!ALLOWED_SOURCES.has(source)) {
    throw new HttpError(400, 'prompt source is invalid');
  }
  const promptId = text(body.prompt_id, '', 128);
  const promptText = sanitizePrompt(body.text);
  if (!promptId || !promptText) {
    throw new HttpError(400, 'prompt_id and sanitized text are required');
  }
  return {
    session_ref: sessionRef,
    source,
    project_alias: text(body.project_alias, 'Codex project', 64),
    prompt: {
      prompt_id: promptId,
      captured_at: normalizedInputTimestamp(body.captured_at),
      text: promptText,
    },
  };
}

function normalizeRemotePrompt(body) {
  const sessionRef = text(body.session_ref, '', 80).toLowerCase();
  if (!/^sha256:[a-f0-9]{16,64}$/.test(sessionRef)) {
    throw new HttpError(400, 'session_ref is invalid', 'invalid_session_ref');
  }
  const mode = text(body.mode, 'queue', 16);
  if (!['queue', 'steer'].includes(mode)) {
    throw new HttpError(400, 'mode is invalid', 'invalid_mode');
  }
  const idempotencyKey = text(body.idempotency_key, '', 128);
  if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw new HttpError(
      400,
      'idempotency_key is invalid',
      'invalid_idempotency_key',
    );
  }
  if (typeof body.prompt !== 'string') {
    throw new HttpError(400, 'prompt is required', 'prompt_required');
  }
  const prompt = body.prompt
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!prompt) {
    throw new HttpError(400, 'prompt is required', 'prompt_required');
  }
  if (prompt.length > MAX_REMOTE_PROMPT_LENGTH) {
    throw new HttpError(
      413,
      `prompt must be at most ${MAX_REMOTE_PROMPT_LENGTH} characters`,
      'prompt_too_long',
    );
  }
  return { idempotencyKey, mode, prompt, sessionRef };
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedInputTimestamp(value, now = Date.now()) {
  const parsed = Date.parse(
    typeof value === 'string' ? value : '',
  );
  if (!Number.isFinite(parsed) || parsed > now + 5 * 60 * 1000) {
    return new Date(now).toISOString();
  }
  return new Date(parsed).toISOString();
}

function pruneAgentSessions(device) {
  const previous = device.agentSessions ?? [];
  const cutoff = Date.now() - PROMPT_RETENTION_MS;
  let changed = false;
  for (const session of previous) {
    const prompts = Array.isArray(session.prompts) ? session.prompts : [];
    const retained = prompts.filter(
      (prompt) => timestamp(prompt.captured_at) >= cutoff,
    );
    if (retained.length !== prompts.length) changed = true;
    session.prompts = retained.slice(-MAX_PROMPTS_PER_SESSION);
  }
  const next = previous
    .filter((session) => timestamp(session.updated_at) >= cutoff)
    .sort((left, right) => timestamp(left.updated_at) - timestamp(right.updated_at))
    .slice(-MAX_AGENT_SESSIONS);
  device.agentSessions = next;
  return changed || next.length !== previous.length;
}

function getOrCreateAgentSession(device, input) {
  device.agentSessions ??= [];
  let session = device.agentSessions.find(
    (candidate) => candidate.session_ref === input.session_ref,
  );
  if (!session) {
    session = {
      session_ref: input.session_ref,
      source: input.source,
      project_alias: input.project_alias,
      state: 'working',
      summary: '已收到新的工作指令',
      // The first lifecycle event is timestamped before it reaches the Relay.
      // Start at the epoch so that event, rather than this placeholder, wins.
      updated_at: new Date(0).toISOString(),
      last_event_at: null,
      acknowledged_at: null,
      prompts: [],
    };
    device.agentSessions.push(session);
  }
  return session;
}

function updateSessionFromPrompt(device, capture) {
  pruneAgentSessions(device);
  const session = getOrCreateAgentSession(device, capture);
  session.source = capture.source;
  session.project_alias = capture.project_alias;
  session.state = 'working';
  session.summary = '已收到新的工作指令';
  session.updated_at = capture.prompt.captured_at;
  session.acknowledged_at = null;
  if (
    !session.prompts.some(
      (prompt) => prompt.prompt_id === capture.prompt.prompt_id,
    )
  ) {
    session.prompts.push(capture.prompt);
    session.prompts = session.prompts.slice(-MAX_PROMPTS_PER_SESSION);
  }
  pruneAgentSessions(device);
}

function updateSessionFromEvent(device, event) {
  if (!event.session_ref) return;
  pruneAgentSessions(device);
  const session = getOrCreateAgentSession(device, {
    session_ref: event.session_ref,
    source: event.source,
    project_alias: event.project_alias,
  });
  if (timestamp(event.occurred_at) >= timestamp(session.updated_at)) {
    session.source = event.source;
    session.project_alias = event.project_alias;
    session.state = event.state;
    session.summary = event.summary;
    session.updated_at = event.occurred_at;
    session.last_event_at = event.occurred_at;
    session.acknowledged_at = event.acknowledged_at ?? null;
  }
  pruneAgentSessions(device);
}

function sessionControlStatus(session, codexControl) {
  if (session.source !== 'codex') return 'unsupported';
  return codexControl?.statusForSession?.(session.session_ref) ?? 'setup_required';
}

function validateSessionRef(value) {
  const sessionRef = text(value, '', 80);
  if (!/^sha256:[a-f0-9]{16,64}$/i.test(sessionRef)) {
    throw new HttpError(400, 'session_ref is invalid', 'invalid_session_ref');
  }
  return sessionRef;
}

function requireControlSession(device, sessionRef, codexControl) {
  const session = (device.agentSessions ?? []).find(
    (candidate) => candidate.session_ref === sessionRef,
  );
  if (!session) {
    throw new HttpError(404, 'session was not found', 'session_not_found');
  }
  const controlStatus = sessionControlStatus(session, codexControl);
  if (controlStatus !== 'ready') {
    const message =
      controlStatus === 'unsupported'
        ? '这个 Agent 来源暂不支持手机控制。'
        : controlStatus === 'observe_only'
          ? '这个会话目前只能观察；请在电脑端用 codexy 打开它。'
          : '电脑端控制桥接尚未就绪。';
    throw new HttpError(
      controlStatus === 'checking' ? 503 : 409,
      message,
      `control_${controlStatus}`,
    );
  }
  return session;
}

function normalizeControlIdempotencyKey(value) {
  const key = text(value, '', 128);
  if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) {
    throw new HttpError(
      400,
      'idempotency_key is invalid',
      'invalid_idempotency_key',
    );
  }
  return key;
}

function normalizeControlSettings(body) {
  const model =
    typeof body.model === 'string'
      ? text(body.model, '', 80)
      : null;
  const reasoningEffort =
    typeof body.reasoning_effort === 'string'
      ? text(body.reasoning_effort, '', 32)
      : null;
  if (!model && !reasoningEffort) {
    throw new HttpError(
      400,
      'model or reasoning_effort is required',
      'empty_control_settings',
    );
  }
  return {
    model,
    reasoningEffort,
    idempotencyKey: normalizeControlIdempotencyKey(
      body.idempotency_key,
    ),
  };
}

function normalizeControlAction(body) {
  const action = text(body.action, '', 24);
  if (!CONTROL_ACTIONS.has(action)) {
    throw new HttpError(
      400,
      'control action is invalid',
      'invalid_control_action',
    );
  }
  return {
    action,
    idempotencyKey: normalizeControlIdempotencyKey(
      body.idempotency_key,
    ),
  };
}

function publicControlRateWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const usedPercent = Number(value.used_percent);
  const windowMinutes = Number(value.window_minutes);
  const resetsAt = text(value.resets_at, '', 64);
  return {
    used_percent: Number.isFinite(usedPercent)
      ? Math.max(0, Math.min(100, usedPercent))
      : 0,
    window_minutes:
      Number.isFinite(windowMinutes) && windowMinutes >= 0
        ? windowMinutes
        : null,
    resets_at:
      resetsAt && Number.isFinite(Date.parse(resetsAt))
        ? resetsAt
        : null,
  };
}

function publicControlSnapshot(value, sessionRef) {
  const snapshot =
    value && typeof value === 'object' ? value : {};
  const models = (Array.isArray(snapshot.models) ? snapshot.models : [])
    .map((item) => {
      const id = text(item?.id, '', 80);
      if (!/^[a-zA-Z0-9._:+-]{1,80}$/.test(id)) return null;
      const supportedEfforts = [
        ...new Set(
          (
            Array.isArray(item.supported_efforts)
              ? item.supported_efforts
              : []
          )
            .map((effort) => text(effort, '', 32))
            .filter((effort) =>
              /^[a-zA-Z0-9._:+-]{1,32}$/.test(effort),
            ),
        ),
      ];
      const defaultEffort = text(item.default_effort, '', 32);
      return {
        id,
        display_name: text(item.display_name, id, 64),
        description: text(item.description, '', 180),
        is_default: item.is_default === true,
        supported_efforts: supportedEfforts,
        default_effort: supportedEfforts.includes(defaultEffort)
          ? defaultEffort
          : supportedEfforts[0] ?? null,
      };
    })
    .filter(Boolean);
  const identifier = (candidate, fallback = null, max = 80) => {
    const cleaned = text(candidate, '', max);
    return /^[a-zA-Z0-9._:+-]+$/.test(cleaned)
      ? cleaned
      : fallback;
  };
  const actions =
    snapshot.available_actions &&
    typeof snapshot.available_actions === 'object'
      ? snapshot.available_actions
      : {};
  const rateLimit =
    snapshot.rate_limit && typeof snapshot.rate_limit === 'object'
      ? {
          primary: publicControlRateWindow(snapshot.rate_limit.primary),
          secondary: publicControlRateWindow(snapshot.rate_limit.secondary),
        }
      : null;
  const refreshedAt = text(snapshot.refreshed_at, '', 64);
  return {
    session_ref: sessionRef,
    control_status: 'ready',
    session_state: identifier(snapshot.session_state, 'idle', 24),
    model: identifier(snapshot.model),
    reasoning_effort: identifier(
      snapshot.reasoning_effort,
      null,
      32,
    ),
    approval_policy: identifier(
      snapshot.approval_policy,
      'custom',
      32,
    ),
    permission_profile: identifier(
      snapshot.permission_profile,
      'custom',
      32,
    ),
    settings_apply_to: 'subsequent_turns',
    models,
    rate_limit: rateLimit,
    available_actions: {
      status: actions.status === true,
      compact: actions.compact === true,
      review: actions.review === true,
      interrupt: actions.interrupt === true,
    },
    refreshed_at:
      refreshedAt && Number.isFinite(Date.parse(refreshedAt))
        ? refreshedAt
        : new Date().toISOString(),
  };
}

function publicControlActionResult(value, sessionRef) {
  const action = text(value?.action, '', 24);
  return {
    action: CONTROL_ACTIONS.has(action) ? action : 'status',
    accepted: value?.accepted === true,
    detail: text(value?.detail, 'Control action accepted.', 160),
    snapshot: publicControlSnapshot(value?.snapshot, sessionRef),
  };
}

function publicReplySummary(value, sessionRef) {
  const summary =
    value && typeof value === 'object' ? value : {};
  const kinds = new Set([
    'outcome',
    'verification',
    'attention',
    'next',
    'detail',
  ]);
  const labels = {
    outcome: '完成',
    verification: '验证',
    attention: '注意',
    next: '下一步',
    detail: '要点',
  };
  const safeSummaryText = (candidate, maximum) =>
    text(sanitizeAgentReply(candidate), '', maximum);
  const headline = safeSummaryText(summary.headline, 112);
  const available = summary.available === true && Boolean(headline);
  const highlights = available
    ? (Array.isArray(summary.highlights) ? summary.highlights : [])
        .map((item) => {
          const kind = text(item?.kind, 'detail', 24);
          const safeKind = kinds.has(kind) ? kind : 'detail';
          const highlightText = safeSummaryText(item?.text, 190);
          if (!highlightText) return null;
          return {
            kind: safeKind,
            label: labels[safeKind],
            text: highlightText,
          };
        })
        .filter(Boolean)
        .slice(0, 4)
    : [];
  const timestamp = (candidate) => {
    const cleaned = text(candidate, '', 64);
    return cleaned && Number.isFinite(Date.parse(cleaned))
      ? cleaned
      : null;
  };
  const sourceCharacters = Number(summary.source_characters);
  return {
    available,
    session_ref: sessionRef,
    current_turn_active: summary.current_turn_active === true,
    reason: available
      ? null
      : publicStringIdentifier(
          summary.reason,
          'no_final_reply',
          48,
        ),
    turn_status: available
      ? publicStringIdentifier(
          summary.turn_status,
          'completed',
          24,
        )
      : null,
    completed_at: available
      ? timestamp(summary.completed_at)
      : null,
    headline: available ? headline : null,
    highlights,
    summary_method: 'local_extract',
    source_characters:
      Number.isFinite(sourceCharacters) && sourceCharacters >= 0
        ? Math.min(Math.round(sourceCharacters), 1_000_000)
        : 0,
    source_truncated: summary.source_truncated === true,
    raw_response_exposed: false,
    persisted: false,
    generated_at:
      timestamp(summary.generated_at) ?? new Date().toISOString(),
  };
}

function publicStringIdentifier(value, fallback, maximum) {
  const identifier = text(value, '', maximum);
  return /^[a-zA-Z0-9._:+-]+$/.test(identifier)
    ? identifier
    : fallback;
}

function publicAgentSessions(device, codexControl) {
  return [...(device.agentSessions ?? [])]
    .sort((left, right) => timestamp(right.updated_at) - timestamp(left.updated_at))
    .map((session) => ({
      ...session,
      prompt_count: session.prompts.length,
      control_status: sessionControlStatus(session, codexControl),
    }));
}

function normalizeWebPushSubscription(body) {
  const subscription =
    body.subscription && typeof body.subscription === 'object'
      ? body.subscription
      : body;
  const endpoint = text(subscription.endpoint, '', 2048);
  const p256dh = text(subscription.keys?.p256dh, '', 256);
  const auth = text(subscription.keys?.auth, '', 256);
  if (!endpoint.startsWith('https://') || !p256dh || !auth) {
    throw new HttpError(400, 'web push subscription is invalid');
  }
  return {
    endpoint,
    expirationTime:
      typeof subscription.expirationTime === 'number'
        ? subscription.expirationTime
        : null,
    keys: { p256dh, auth },
  };
}

export function createRelayServer(options = {}) {
  const pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
  const pushSender = options.pushSender ?? sendExpoPush;
  const stateFile = options.stateFile ?? null;
  const webRoot = options.webRoot ?? null;
  const vapid = normalizeVapidConfig(options.vapid);
  const webPushSender =
    options.webPushSender ?? createWebPushSender(vapid);
  const store = loadRelayStore(stateFile);
  const persist = () => persistRelayStore(stateFile, store);
  const allowedOrigins = configuredOrigins(
    options.allowedOrigins ?? process.env.CODEXY_ALLOWED_ORIGINS,
  );
  const rateLimitOptions = options.rateLimitOptions ?? {};
  const registrationLimiter = createAttemptLimiter({
    limit:
      rateLimitOptions.registrationLimit ??
      DEFAULT_REGISTRATION_LIMIT,
    windowMs:
      rateLimitOptions.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    now: rateLimitOptions.now,
  });
  const pairingClaimLimiter = createAttemptLimiter({
    limit:
      rateLimitOptions.pairingClaimLimit ??
      DEFAULT_PAIRING_CLAIM_LIMIT,
    windowMs:
      rateLimitOptions.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    now: rateLimitOptions.now,
  });
  const codexControl =
    options.codexControl ?? createCodexControlFromEnvironment();
  const remoteCommands = createRemoteCommandManager({
    dispatch: (command, setStatus) =>
      codexControl.dispatch(command, setStatus),
    ...(options.remoteCommandOptions ?? {}),
  });
  const controlRequests = new Map();

  function pruneControlRequests() {
    const cutoff = Date.now() - CONTROL_REQUEST_RETENTION_MS;
    for (const [key, entry] of controlRequests) {
      if (entry.createdAt < cutoff) controlRequests.delete(key);
    }
    while (controlRequests.size > MAX_CONTROL_REQUESTS) {
      const oldest = controlRequests.keys().next().value;
      if (!oldest) break;
      controlRequests.delete(oldest);
    }
  }

  function runIdempotentControlRequest(
    deviceId,
    idempotencyKey,
    execute,
  ) {
    pruneControlRequests();
    const key = `${deviceId}:${idempotencyKey}`;
    const existing = controlRequests.get(key);
    if (existing) return existing.promise;
    const promise = Promise.resolve()
      .then(execute)
      .catch((error) => {
        if (controlRequests.get(key)?.promise === promise) {
          controlRequests.delete(key);
        }
        throw error;
      });
    controlRequests.set(key, {
      createdAt: Date.now(),
      promise,
    });
    return promise;
  }
  void codexControl.start?.().catch((error) => {
    console.error(
      `Codex control bridge unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  const server = http.createServer(async (request, response) => {
    const requestOrigin = request.headers.origin;
    const corsOrigin = allowedCorsOrigin(request, allowedOrigins);
    response.codexyCorsOrigin = corsOrigin;
    if (requestOrigin && !corsOrigin) {
      sendJson(response, 403, {
        error: 'request origin is not allowed',
        error_code: 'origin_not_allowed',
      });
      return;
    }
    if (request.method === 'OPTIONS') {
      sendJson(response, 204, {});
      return;
    }

    try {
      const url = new URL(request.url ?? '/', 'http://relay.local');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          service: 'codexy-relay',
          devices: store.devices.size,
          web_push_configured: vapid.configured,
          web_app_configured: Boolean(webRoot),
          remote_control: codexControl.getStatus?.() ?? {
            state: 'disabled',
            detail: 'Desktop control is disabled.',
            endpoint: null,
          },
        });
        return;
      }

      if (
        request.method === 'GET' &&
        segments.join('/') === 'v1/web-push/vapid-public-key'
      ) {
        if (!vapid.configured) {
          throw new HttpError(503, 'web push is not configured');
        }
        sendJson(response, 200, { public_key: vapid.publicKey });
        return;
      }

      if (
        request.method === 'POST' &&
        segments.join('/') === 'v1/devices/register'
      ) {
        if (!registrationLimiter.take(rateLimitKey(request))) {
          throw new HttpError(
            429,
            'too many device registration attempts',
            'registration_rate_limited',
          );
        }
        const body = await readJson(request);
        const deviceId = validateDeviceId(body.device_id);
        let device = store.devices.get(deviceId);
        if (device) {
          if (!safeEqual(bearerToken(request), device.deviceSecret)) {
            throw new HttpError(401, 'existing device requires its device credential');
          }
        } else {
          device = {
            deviceId,
            deviceSecret: secureToken(),
            expoPushToken: null,
            platform: 'unknown',
            pairingCode: null,
            pairingExpiresAt: null,
            hookToken: null,
            events: [],
            dedupeKeys: new Set(),
            nextCursor: 0,
            agentSessions: [],
            webPushSubscriptions: [],
            preferences: { ...DEFAULT_DEVICE_PREFERENCES },
          };
          store.devices.set(deviceId, device);
        }

        device.platform = text(body.platform, 'unknown', 24);
        device.expoPushToken =
          typeof body.expo_push_token === 'string'
            ? text(body.expo_push_token, '', 256)
            : null;

        const pairingExpired =
          !device.pairingExpiresAt || device.pairingExpiresAt <= Date.now();
        if (!device.hookToken && (!device.pairingCode || pairingExpired)) {
          device.pairingCode = createPairingCode(store);
          device.pairingExpiresAt = Date.now() + pairingTtlMs;
        }

        persist();
        sendJson(response, 200, {
          device_id: device.deviceId,
          device_secret: device.deviceSecret,
          pairing_code: device.pairingCode,
          pairing_expires_at: device.pairingExpiresAt
            ? new Date(device.pairingExpiresAt).toISOString()
            : null,
          paired: Boolean(device.hookToken),
        });
        return;
      }

      if (
        request.method === 'POST' &&
        segments.join('/') === 'v1/pairings/claim'
      ) {
        if (!isLocalManagementRequest(request)) {
          throw new HttpError(
            403,
            'pairing must be confirmed from localhost',
            'local_pairing_required',
          );
        }
        if (!pairingClaimLimiter.take(rateLimitKey(request))) {
          throw new HttpError(
            429,
            'too many pairing attempts',
            'pairing_rate_limited',
          );
        }
        const body = await readJson(request);
        const pairingCode = text(body.pairing_code, '', 6);
        const device = [...store.devices.values()].find(
          (candidate) =>
            candidate.pairingCode === pairingCode &&
            candidate.pairingExpiresAt > Date.now(),
        );
        if (!device) {
          throw new HttpError(404, 'pairing code is invalid or expired');
        }

        const hookToken = secureToken();
        for (const candidate of store.devices.values()) {
          if (
            candidate.deviceId !== device.deviceId &&
            candidate.hookToken
          ) {
            store.hookTokens.delete(candidate.hookToken);
            candidate.hookToken = null;
          }
        }
        if (device.hookToken) store.hookTokens.delete(device.hookToken);
        device.hookToken = hookToken;
        device.pairingCode = null;
        device.pairingExpiresAt = null;
        store.hookTokens.set(hookToken, device.deviceId);
        store.activeDeviceId = device.deviceId;

        persist();
        sendJson(response, 200, {
          device_id: device.deviceId,
          relay_token: hookToken,
          event_url: '/v1/events',
        });
        return;
      }

      if (segments[0] === 'v1' && segments[1] === 'devices' && segments[2]) {
        const deviceId = validateDeviceId(segments[2]);
        const device = requireDevice(store, deviceId, request);

        if (request.method === 'DELETE' && segments.length === 3) {
          if (device.hookToken) {
            store.hookTokens.delete(device.hookToken);
          }
          if (store.activeDeviceId === device.deviceId) {
            store.activeDeviceId = null;
          }
          remoteCommands.removeDevice(device.deviceId);
          store.devices.delete(device.deviceId);
          persist();
          sendJson(response, 200, {
            deleted: true,
            device_id: device.deviceId,
          });
          return;
        }

        if (request.method === 'GET' && segments[3] === 'status') {
          sendJson(response, 200, {
            device_id: device.deviceId,
            paired: Boolean(device.hookToken),
            pairing_code: device.pairingCode,
            pairing_expires_at: device.pairingExpiresAt
              ? new Date(device.pairingExpiresAt).toISOString()
              : null,
            push_configured: Boolean(
              device.expoPushToken || device.webPushSubscriptions?.length,
            ),
            web_push_configured: Boolean(
              device.webPushSubscriptions?.length,
            ),
            preferences: normalizeDevicePreferences(device.preferences),
            remote_control: codexControl.getStatus?.() ?? {
              state: 'disabled',
              detail: '桌面端尚未启用远程控制。',
              endpoint: null,
            },
          });
          return;
        }

        if (
          request.method === 'PATCH' &&
          segments[3] === 'preferences' &&
          segments.length === 4
        ) {
          device.preferences = updateDevicePreferences(
            device.preferences,
            await readJson(request),
          );
          persist();
          sendJson(response, 200, {
            device_id: device.deviceId,
            preferences: device.preferences,
          });
          return;
        }

        if (
          request.method === 'POST' &&
          segments[3] === 'web-push-subscriptions' &&
          segments.length === 4
        ) {
          if (!vapid.configured) {
            throw new HttpError(503, 'web push is not configured');
          }
          const subscription = normalizeWebPushSubscription(
            await readJson(request),
          );
          const current = device.webPushSubscriptions ?? [];
          device.webPushSubscriptions = [
            ...current.filter(
              (candidate) => candidate.endpoint !== subscription.endpoint,
            ),
            subscription,
          ].slice(-MAX_WEB_PUSH_SUBSCRIPTIONS);
          persist();
          sendJson(response, 200, {
            subscribed: true,
            subscription_count: device.webPushSubscriptions.length,
          });
          return;
        }

        if (
          request.method === 'GET' &&
          segments[3] === 'events' &&
          segments.length === 4
        ) {
          const after = Number(url.searchParams.get('after') ?? 0);
          const safeAfter = Number.isFinite(after) && after >= 0 ? after : 0;
          sendJson(response, 200, {
            events: device.events.filter((event) => event.cursor > safeAfter),
            next_cursor: device.nextCursor,
          });
          return;
        }

        if (
          request.method === 'POST' &&
          segments[3] === 'events' &&
          segments[4] &&
          segments[5] === 'ack'
        ) {
          await readJson(request);
          const event = device.events.find(
            (candidate) => candidate.event_id === segments[4],
          );
          if (!event) throw new HttpError(404, 'event was not found');
          event.acknowledged_at = new Date().toISOString();
          if (event.session_ref) {
            const session = (device.agentSessions ?? []).find(
              (candidate) => candidate.session_ref === event.session_ref,
            );
            if (session) {
              session.acknowledged_at = event.acknowledged_at;
            }
          }
          persist();
          sendJson(response, 200, { acknowledged: true });
          return;
        }

        if (
          request.method === 'GET' &&
          segments[3] === 'sessions' &&
          segments.length === 4
        ) {
          const changed = pruneAgentSessions(device);
          if (changed) persist();
          sendJson(response, 200, {
            sessions: publicAgentSessions(device, codexControl),
            retention_hours: PROMPT_RETENTION_MS / (60 * 60 * 1000),
          });
          return;
        }

        if (
          request.method === 'GET' &&
          segments[3] === 'sessions' &&
          segments[4] &&
          segments[5] === 'reply-summary' &&
          segments.length === 6
        ) {
          const sessionRef = validateSessionRef(segments[4]);
          requireControlSession(device, sessionRef, codexControl);
          const summary = await codexControl.getSessionResponseSummary(
            sessionRef,
          );
          sendJson(response, 200, {
            summary: publicReplySummary(summary, sessionRef),
            raw_response_exposed: false,
            persisted: false,
          });
          return;
        }

        if (
          request.method === 'GET' &&
          segments[3] === 'sessions' &&
          segments[4] &&
          segments[5] === 'control' &&
          segments.length === 6
        ) {
          const sessionRef = validateSessionRef(segments[4]);
          requireControlSession(device, sessionRef, codexControl);
          const snapshot = await codexControl.getSessionControl(
            sessionRef,
          );
          sendJson(response, 200, {
            snapshot: publicControlSnapshot(snapshot, sessionRef),
            raw_thread_id_exposed: false,
            working_directory_exposed: false,
          });
          return;
        }

        if (
          request.method === 'PATCH' &&
          segments[3] === 'sessions' &&
          segments[4] &&
          segments[5] === 'control' &&
          segments.length === 6
        ) {
          const sessionRef = validateSessionRef(segments[4]);
          requireControlSession(device, sessionRef, codexControl);
          const input = normalizeControlSettings(await readJson(request));
          const snapshot = await runIdempotentControlRequest(
            device.deviceId,
            `settings:${sessionRef}:${input.idempotencyKey}`,
            () =>
              codexControl.updateSessionSettings(sessionRef, {
                model: input.model,
                reasoningEffort: input.reasoningEffort,
              }),
          );
          sendJson(response, 200, {
            applied: true,
            applies_to: 'subsequent_turns',
            snapshot: publicControlSnapshot(snapshot, sessionRef),
          });
          return;
        }

        if (
          request.method === 'POST' &&
          segments[3] === 'sessions' &&
          segments[4] &&
          segments[5] === 'actions' &&
          segments.length === 6
        ) {
          const sessionRef = validateSessionRef(segments[4]);
          requireControlSession(device, sessionRef, codexControl);
          const input = normalizeControlAction(await readJson(request));
          const result = await runIdempotentControlRequest(
            device.deviceId,
            `action:${sessionRef}:${input.idempotencyKey}`,
            () =>
              codexControl.runSessionAction(
                sessionRef,
                input.action,
              ),
          );
          sendJson(
            response,
            input.action === 'status' ? 200 : 202,
            {
              result: publicControlActionResult(
                result,
                sessionRef,
              ),
            },
          );
          return;
        }

        if (
          request.method === 'GET' &&
          segments[3] === 'remote-prompts' &&
          segments.length === 4
        ) {
          sendJson(response, 200, {
            commands: remoteCommands.list(device.deviceId),
            exact_prompt_persisted: false,
          });
          return;
        }

        if (
          request.method === 'GET' &&
          segments[3] === 'remote-prompts' &&
          segments[4] &&
          segments.length === 5
        ) {
          const command = remoteCommands.get(device.deviceId, segments[4]);
          if (!command) {
            throw new HttpError(
              404,
              'remote prompt was not found',
              'command_not_found',
            );
          }
          sendJson(response, 200, { command });
          return;
        }

        if (
          request.method === 'POST' &&
          segments[3] === 'remote-prompts' &&
          segments.length === 4
        ) {
          const input = normalizeRemotePrompt(await readJson(request));
          const session = (device.agentSessions ?? []).find(
            (candidate) => candidate.session_ref === input.sessionRef,
          );
          if (!session) {
            throw new HttpError(
              404,
              'session was not found',
              'session_not_found',
            );
          }
          const controlStatus = sessionControlStatus(session, codexControl);
          if (controlStatus !== 'ready') {
            const message =
              controlStatus === 'unsupported'
                ? '这个 Agent 来源暂不支持手机直发指令。'
                : controlStatus === 'observe_only'
                  ? '这个会话目前只能观察；请在电脑端用 codexy 打开它。'
                  : '电脑端控制桥接尚未就绪。';
            throw new HttpError(
              controlStatus === 'checking' ? 503 : 409,
              message,
              `control_${controlStatus}`,
            );
          }
          const command = remoteCommands.enqueue({
            deviceId: device.deviceId,
            sessionRef: input.sessionRef,
            prompt: input.prompt,
            mode: input.mode,
            idempotencyKey: input.idempotencyKey,
          });
          sendJson(response, 202, {
            command,
            exact_prompt_persisted: false,
          });
          return;
        }

        if (
          request.method === 'POST' &&
          segments[3] === 'remote-prompts' &&
          segments[4] &&
          segments[5] === 'cancel' &&
          segments.length === 6
        ) {
          await readJson(request);
          const command = remoteCommands.cancel(
            device.deviceId,
            segments[4],
          );
          if (!command) {
            throw new HttpError(
              404,
              'remote prompt was not found',
              'command_not_found',
            );
          }
          sendJson(response, 200, { command });
          return;
        }
      }

      if (request.method === 'POST' && segments.join('/') === 'v1/prompts') {
        const device = requirePairedDevice(store, request);
        const capture = normalizePromptCapture(await readJson(request));
        updateSessionFromPrompt(device, capture);
        persist();
        sendJson(response, 202, {
          accepted: true,
          session_ref: capture.session_ref,
          prompt_count:
            device.agentSessions.find(
              (session) => session.session_ref === capture.session_ref,
            )?.prompts.length ?? 0,
        });
        return;
      }

      if (request.method === 'POST' && segments.join('/') === 'v1/events') {
        const device = requirePairedDevice(store, request);
        const event = normalizeEvent(await readJson(request));
        if (device.dedupeKeys.has(event.dedupe_key)) {
          sendJson(response, 200, {
            accepted: true,
            deduplicated: true,
            push_status: 'not_repeated',
          });
          return;
        }

        device.nextCursor += 1;
        const storedEvent = { ...event, cursor: device.nextCursor };
        device.events.push(storedEvent);
        device.dedupeKeys.add(event.dedupe_key);
        if (device.events.length > MAX_EVENTS_PER_DEVICE) {
          const removed = device.events.splice(
            0,
            device.events.length - MAX_EVENTS_PER_DEVICE,
          );
          for (const item of removed) device.dedupeKeys.delete(item.dedupe_key);
        }
        updateSessionFromEvent(device, storedEvent);

        persist();
        const preferences = normalizeDevicePreferences(device.preferences);
        const shouldPush = shouldNotifyForLevel(
          storedEvent.state,
          preferences.notification_level,
        );
        const [expoPushResult, webPushResult] = shouldPush
          ? await Promise.all([
              pushSender(device.expoPushToken, storedEvent, preferences),
              webPushSender(
                device.webPushSubscriptions ?? [],
                storedEvent,
                preferences,
              ),
            ])
          : [
              { status: 'filtered' },
              { status: 'filtered', sent: 0, expiredEndpoints: [] },
            ];
        if (webPushResult.expiredEndpoints?.length) {
          const expired = new Set(webPushResult.expiredEndpoints);
          device.webPushSubscriptions = (
            device.webPushSubscriptions ?? []
          ).filter((subscription) => !expired.has(subscription.endpoint));
          persist();
        }
        if (expoPushResult.status === 'expired') {
          device.expoPushToken = null;
          persist();
        }
        sendJson(response, 202, {
          accepted: true,
          deduplicated: false,
          cursor: storedEvent.cursor,
          push_status:
            webPushResult.status === 'sent'
              ? 'sent'
              : expoPushResult.status,
          push_channels: {
            expo: expoPushResult.status,
            web: webPushResult.status,
          },
        });
        return;
      }

      if (
        await tryServeStatic({
          request,
          response,
          url,
          webRoot,
        })
      ) {
        return;
      }

      throw new HttpError(404, 'route was not found');
    } catch (error) {
      const status =
        error instanceof HttpError || error instanceof RemoteCommandError
          ? error.status
          : 500;
      const message =
        error instanceof Error ? error.message : 'unexpected relay error';
      sendJson(response, status, {
        error: status === 500 ? 'unexpected relay error' : message,
        ...(error instanceof HttpError || error instanceof RemoteCommandError
          ? { error_code: error.code }
          : {}),
      });
      if (status === 500) console.error(error);
    }
  });

  server.on('close', () => {
    remoteCommands.close();
    codexControl.stop?.();
  });

  return { codexControl, remoteCommands, server, store };
}

function parseServerArgs(argv) {
  const result = {
    host:
      process.env.CODEXY_RELAY_HOST ??
      process.env.ATTENTION_RELAY_HOST ??
      '127.0.0.1',
    port: Number(
      process.env.CODEXY_RELAY_PORT ??
        process.env.ATTENTION_RELAY_PORT ??
        8797,
    ),
    stateFile:
      process.env.CODEXY_RELAY_STATE_FILE ??
      process.env.ATTENTION_RELAY_STATE_FILE ??
      join(homedir(), '.codex', 'codexy', 'relay-state.json'),
    webRoot:
      process.env.CODEXY_WEB_ROOT ??
      process.env.ATTENTION_WEB_ROOT ??
      null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--host') result.host = argv[index + 1] ?? result.host;
    if (argv[index] === '--port') result.port = Number(argv[index + 1] ?? result.port);
  }
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new Error('relay port must be between 1 and 65535');
  }
  return result;
}

async function main() {
  const { host, port, stateFile, webRoot } = parseServerArgs(
    process.argv.slice(2),
  );
  const { server } = createRelayServer({
    stateFile,
    webRoot,
    vapid: {
      subject:
        process.env.CODEXY_VAPID_SUBJECT ??
        process.env.ATTENTION_VAPID_SUBJECT,
      publicKey:
        process.env.CODEXY_VAPID_PUBLIC_KEY ??
        process.env.ATTENTION_VAPID_PUBLIC_KEY,
      privateKey:
        process.env.CODEXY_VAPID_PRIVATE_KEY ??
        process.env.ATTENTION_VAPID_PRIVATE_KEY,
    },
  });
  server.listen(port, host, () => {
    console.log(`Codexy Relay listening on http://${host}:${port}`);
    console.log(`Relay state: ${stateFile}`);
    if (webRoot) console.log(`Private PWA root: ${webRoot}`);
    if (host === '0.0.0.0') {
      console.log('LAN mode enabled. Keep this development relay behind a trusted network.');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export const DEFAULT_DEVICE_PREFERENCES = Object.freeze({
  notification_tone: 'calm',
  notification_level: 'important',
});

export const NOTIFICATION_TONES = new Set(['calm', 'direct', 'playful']);
export const NOTIFICATION_LEVELS = new Set([
  'decisions',
  'important',
  'all',
]);

const DECISION_STATES = new Set(['needs_you', 'failed']);
const IMPORTANT_STATES = new Set([
  ...DECISION_STATES,
  'turn_finished',
  'completed',
  'session_ended',
]);

const TITLES = {
  calm: {
    working: 'Codex 已开始处理',
    needs_you: '有一件事等你决定',
    turn_finished: '这一轮已经结束',
    subtask_completed: '一个子任务已处理',
    completed: 'Codex 已完成任务',
    failed: 'Codex 遇到了阻碍',
    interrupted: 'Codex 已暂停',
    background_ended: '后台任务已结束',
    session_ended: '这次 Codex 会话已结束',
    fallback: 'Codex 状态有更新',
  },
  direct: {
    working: 'Codex：正在工作',
    needs_you: 'Codex：需要你确认',
    turn_finished: 'Codex：本轮已结束',
    subtask_completed: 'Codex：子任务已完成',
    completed: 'Codex：任务已完成',
    failed: 'Codex：运行失败',
    interrupted: 'Codex：运行已中断',
    background_ended: 'Codex：后台任务已结束',
    session_ended: 'Codex：会话已结束',
    fallback: 'Codex：状态更新',
  },
  playful: {
    working: 'Codex 接棒了',
    needs_you: '轮到你接棒了',
    turn_finished: '这一轮先到这里',
    subtask_completed: '一个小关卡通过了',
    completed: '这一程跑完了',
    failed: '这一步没有跑通',
    interrupted: '先在这里按下暂停',
    background_ended: '后台这一程结束了',
    session_ended: '这次搭档回合收尾了',
    fallback: '你的 Codex 搭档有新动静',
  },
};

function safeText(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || fallback).slice(0, maxLength);
}

export function normalizeDevicePreferences(value = {}) {
  return {
    notification_tone: NOTIFICATION_TONES.has(value?.notification_tone)
      ? value.notification_tone
      : DEFAULT_DEVICE_PREFERENCES.notification_tone,
    notification_level: NOTIFICATION_LEVELS.has(value?.notification_level)
      ? value.notification_level
      : DEFAULT_DEVICE_PREFERENCES.notification_level,
  };
}

export function shouldNotifyForLevel(state, level) {
  const normalizedLevel = NOTIFICATION_LEVELS.has(level)
    ? level
    : DEFAULT_DEVICE_PREFERENCES.notification_level;
  if (normalizedLevel === 'all') return true;
  if (normalizedLevel === 'decisions') return DECISION_STATES.has(state);
  return IMPORTANT_STATES.has(state);
}

export function notificationTagForEvent(event) {
  const sessionRef = safeText(event?.session_ref, '', 80).toLowerCase();
  if (sessionRef) {
    return `codexy-session-${sessionRef.replace(/[^a-z0-9_-]/g, '-')}`;
  }
  const eventId = safeText(event?.event_id, 'unknown', 128);
  return `codexy-event-${eventId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function navigationForEvent(event) {
  if (!event?.session_ref) {
    return { deepLink: 'codexy://', url: '/' };
  }
  const encoded = encodeURIComponent(event.session_ref);
  return {
    deepLink: `codexy://session/${encoded}`,
    url: `/?session_ref=${encoded}`,
  };
}

function bodyForEvent(event, tone) {
  const project = safeText(event?.project_alias, 'Codex project', 64);
  const summary = safeText(event?.summary, 'Codex 状态有更新', 160);
  if (tone === 'playful' && event?.state === 'needs_you') {
    return `${project} · Codex 在这里等你的决定：${summary}`;
  }
  if (tone === 'playful' && event?.state === 'failed') {
    return `${project} · 别急，线索还在：${summary}`;
  }
  return `${project} · ${summary}`;
}

export function notificationForEvent(event, preferences = {}) {
  const normalized = normalizeDevicePreferences(preferences);
  const tone = normalized.notification_tone;
  const tag = notificationTagForEvent(event);
  return {
    title: TITLES[tone][event?.state] ?? TITLES[tone].fallback,
    body: bodyForEvent(event, tone),
    tag,
    data: {
      eventId: event?.event_id ?? null,
      event_id: event?.event_id ?? null,
      projectAlias: event?.project_alias ?? null,
      project_alias: event?.project_alias ?? null,
      sessionRef: event?.session_ref ?? null,
      session_ref: event?.session_ref ?? null,
      ...(event?.device_ref ? { device_ref: event.device_ref } : {}),
      state: event?.state ?? null,
      notificationTag: tag,
      notification_tag: tag,
      ...navigationForEvent(event),
    },
  };
}

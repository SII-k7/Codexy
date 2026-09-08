export function projectSessionActivity(session, activity) {
  const base = { ...session, status_source: 'lifecycle', activity_confirmed: false };
  if (!activity) return base;
  let state = session.state;
  let summary = session.summary;
  if (activity.type === 'active') {
    state = activity.needsInput ? 'needs_you' : 'working';
    if (state !== session.state) summary = activity.needsInput ? 'Codex 正在等待授权或输入。' : 'Codex 正在推进当前回合。';
  } else if (activity.type === 'systemError') {
    state = 'failed'; summary = 'Codex 运行状态异常，请查看会话。';
  } else if (activity.type === 'idle' && ['working', 'needs_you'].includes(state)) {
    state = 'turn_finished'; summary = 'Codex 当前已空闲，请核对最近一轮回复。';
  }
  return { ...base, state, summary, status_source: 'app_server', activity_confirmed: true,
    observed_at: activity.observedAt,
    updated_at: Date.parse(activity.updatedAt) > Date.parse(session.updated_at) ? activity.updatedAt : session.updated_at,
    // A new runtime decision must not inherit an older acknowledgement.
    acknowledged_at: state !== session.state ? null : session.acknowledged_at };
}

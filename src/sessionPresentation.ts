import type { AgentSession } from './types';

export type SessionPhase = 'attention' | 'waiting' | 'running' | 'unknown';
export function sessionPhase(session: AgentSession, online: boolean): SessionPhase {
  if (!online) return 'unknown';
  if (['working', 'needs_you'].includes(session.state) && session.activity_confirmed !== true) return 'unknown';
  if (['needs_you', 'failed', 'interrupted'].includes(session.state)) return 'attention';
  if (session.state === 'working') return 'running';
  return 'waiting';
}
export function sessionLabel(session: AgentSession, online: boolean): string {
  if (!online) return '电脑离线';
  const phase = sessionPhase(session, online);
  if (phase === 'unknown') return '状态待确认';
  if (phase === 'running') return '正在推进';
  if (phase === 'waiting') return '等待下一条指令';
  return session.state === 'failed' ? '运行失败' : session.state === 'interrupted' ? '已中断' : '需要你处理';
}
export function latestSessionPrompt(session: AgentSession) {
  return [...(session.prompts ?? [])].sort((a, b) =>
    (Date.parse(b.captured_at) || 0) - (Date.parse(a.captured_at) || 0))[0] ?? null;
}

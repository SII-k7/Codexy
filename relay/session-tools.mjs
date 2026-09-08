import { sanitizeAgentReply } from './response-summary.mjs';
export const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function contextUsage(value) {
  const used = finiteNumber(value?.last?.totalTokens);
  const window = finiteNumber(value?.modelContextWindow);
  if (used === null || !window) return null;
  return { used_tokens: used, window_tokens: window, used_percent: Math.min(100, Math.round(used / window * 100)), estimated: true, observed_at: new Date().toISOString() };
}
export function publicGoal(goal) {
  if (!goal || typeof goal !== 'object') return null;
  if (!['active','paused','blocked','usageLimited','budgetLimited','complete'].includes(goal.status)) return null;
  return { objective: sanitizeAgentReply(goal.objective).slice(0,4000), status: goal.status,
    token_budget: finiteNumber(goal.tokenBudget), tokens_used: finiteNumber(goal.tokensUsed), time_used_seconds: finiteNumber(goal.timeUsedSeconds) };
}
export function weeklyLimit(rate) {
  const window = [rate?.primary, rate?.secondary].find(w => w?.window_minutes === 10080 && finiteNumber(w.used_percent) !== null);
  return window ? { remaining_percent: Math.max(0, Math.min(100, 100-window.used_percent)), resets_at: window.resets_at } : null;
}
export function normalizeGoalInput(body) {
  const action = body?.action;
  if (!['set','pause','resume'].includes(action)) throw new Error('请选择启用、暂停或继续 Goal。');
  if (action !== 'set') return { action };
  const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
  if (!objective || objective.length > 4000) throw new Error('目标须为 1–4000 字符。');
  const tokenBudget = body.token_budget;
  if (tokenBudget !== undefined && tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) throw new Error('Token 预算须为正整数，或留空。');
  return { action, objective, ...(tokenBudget != null ? { tokenBudget } : {}) };
}
export function publicMobileGoal(value) {
  return publicGoal(value ? { objective: value.objective, status: value.status, tokenBudget: value.token_budget, tokensUsed: value.tokens_used, timeUsedSeconds: value.time_used_seconds } : null);
}
export function publicRuntime(value, sessionRef) {
  const context = value?.context;
  const weekly = value?.weekly;
  const date = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
  return { session_ref: sessionRef,
    context: context && finiteNumber(context.used_tokens) !== null && finiteNumber(context.window_tokens) > 0 && date(context.observed_at)
      ? { used_tokens: context.used_tokens, window_tokens: context.window_tokens, used_percent: Math.min(100, Math.round(context.used_tokens/context.window_tokens*100)), estimated: true, observed_at: context.observed_at } : null,
    weekly: weekly && finiteNumber(weekly.remaining_percent) !== null ? { remaining_percent: Math.min(100, weekly.remaining_percent), resets_at: date(weekly.resets_at) } : null,
    goal_available: value?.goal_available === true, goal: publicMobileGoal(value?.goal), refreshed_at: date(value?.refreshed_at) ?? new Date().toISOString() };
}

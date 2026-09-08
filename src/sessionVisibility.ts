import type { AgentSession } from './types';

export function visibleSessionTracks(
  sessions: AgentSession[],
  hiddenSessionRefs: ReadonlySet<string>,
): AgentSession[] {
  return sessions.filter(
    (session) => !hiddenSessionRefs.has(session.session_ref),
  );
}

export function attentionEligibleSessions(
  sessions: AgentSession[],
  hiddenSessionRefs: ReadonlySet<string>,
): AgentSession[] {
  return sessions.filter(
    (session) =>
      !hiddenSessionRefs.has(session.session_ref) ||
      session.state === 'needs_you' ||
      session.state === 'failed',
  );
}

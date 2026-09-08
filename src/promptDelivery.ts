import type { RemotePromptCommand, RemotePromptMode } from './types';

export interface PromptInput {
  relayUrl: string; deviceId: string; deviceSecret: string;
  sessionRef: string; prompt: string; mode: RemotePromptMode;
}

// Retained across opening/closing session screens, but never persisted. A
// retry after a lost HTTP response uses the same key; simultaneous taps share
// one request. Relay restarts are deliberately not promised exactly-once.
export function createPromptSender(
  send: (input: PromptInput & { idempotencyKey: string }) => Promise<RemotePromptCommand>,
  isDefiniteRejection: (error: unknown) => boolean,
  createKey = () => `codexy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
) {
  const attempts = new Map<string, { key: string; request?: Promise<RemotePromptCommand>; timer: ReturnType<typeof setTimeout> }>();
  function submit(input: PromptInput): Promise<RemotePromptCommand> {
    const scope = JSON.stringify([input.relayUrl, input.deviceId, input.sessionRef, input.mode, input.prompt]);
    let attempt = attempts.get(scope);
    if (!attempt) {
      const timer = setTimeout(() => attempts.delete(scope), 30 * 60 * 1000);
      (timer as unknown as { unref?: () => void }).unref?.();
      attempt = { key: createKey(), timer };
      attempts.set(scope, attempt);
    }
    if (attempt.request) return attempt.request;
    const current = attempt;
    const forget = () => { clearTimeout(current.timer); attempts.delete(scope); };
    current.request = send({ ...input, idempotencyKey: current.key }).then((command) => {
      forget(); return command;
    }, (error: unknown) => {
      current.request = undefined;
      if (isDefiniteRejection(error)) forget();
      throw error;
    });
    return current.request;
  }
  return { submit };
}

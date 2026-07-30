import { createHash } from 'node:crypto';

import {
  CONTROL_RE,
  WHITESPACE_RE,
  configured,
  firstString,
  postJson,
  projectAlias,
  rawSessionId,
  readHookInput,
  relayToken,
  runNonBlocking,
  sessionReference,
  validatedEndpoint,
} from './hook_common.mjs';

const MAX_PROMPT_CHARACTERS = 2_000;
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const WINDOWS_PATH_RE =
  /(?<!\w)[A-Za-z]:[\\/](?:[^\s<>:"|?*,，。；;\[\](){}]+[\\/])*[^\s<>:"|?*,，。；;\[\](){}]*/g;
const POSIX_PATH_RE =
  /(?<!\w)\/(?:[^/\s,，。；;\[\](){}]+\/)+[^/\s,，。；;\[\](){}]*/g;
const SECRET_RE =
  /\b(?:bearer\s+)?(?:sk-[a-z0-9_-]{12,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+|eyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{8,})/gi;

function sanitizedPrompt(hook) {
  const params =
    hook?.params && typeof hook.params === 'object' ? hook.params : {};
  const value = firstString(
    hook?.prompt,
    hook?.user_prompt,
    params.prompt,
  );
  if (!value) throw new Error('hook input does not contain a string prompt');
  const text = value
    .normalize('NFKC')
    .replace(FENCED_CODE_RE, ' [code omitted] ')
    .replace(SECRET_RE, '[redacted]')
    .replace(URL_RE, '[link]')
    .replace(EMAIL_RE, '[email]')
    .replace(WINDOWS_PATH_RE, '[path]')
    .replace(POSIX_PATH_RE, '[path]')
    .replace(CONTROL_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim();
  if (!text) throw new Error('prompt is empty after privacy filtering');
  return text.slice(0, MAX_PROMPT_CHARACTERS);
}

await runNonBlocking('prompt', async () => {
  const token = relayToken();
  if (!token) {
    throw new Error('expected one active paired Codexy device');
  }
  const hook = readHookInput();
  const sessionId = rawSessionId(hook);
  if (!sessionId) {
    throw new Error('hook input does not contain a Codex session id');
  }
  const prompt = sanitizedPrompt(hook);
  const turnId =
    firstString(hook.turn_id, hook['turn-id'], hook.turnId) ?? '';
  const promptIdentity = [sessionId, turnId, prompt].join('\x1f');
  await postJson(
    validatedEndpoint(
      configured(
        'CODEXY_PROMPT_RELAY_URL',
        'ATTENTION_PROMPT_RELAY_URL',
      ),
      'http://127.0.0.1:8797/v1/prompts',
    ),
    token,
    {
      schema_version: '1.0',
      session_ref: sessionReference(sessionId),
      source: 'codex',
      project_alias: projectAlias(hook),
      prompt_id: `sha256:${createHash('sha256')
        .update(promptIdentity, 'utf8')
        .digest('hex')
        .slice(0, 24)}`,
      captured_at: new Date().toISOString(),
      text: prompt,
    },
    'codexy-prompt-capture/2.0',
  );
});

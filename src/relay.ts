import type {
  AgentEvent,
  AgentSession,
  DevicePreferences,
  DeviceRegistration,
  DeviceStatus,
  RemotePromptCommand,
  RemotePromptMode,
} from './types';

const REQUEST_TIMEOUT_MS = 5000;

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

export function normalizeRelayUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

async function requestJson<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (!response.ok) {
      throw new RelayError(
        body.error || `Relay 返回 HTTP ${response.status}`,
        response.status,
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RelayError('连接 Relay 超时，请检查地址和网络。');
    }
    throw new RelayError(
      error instanceof Error ? error.message : '无法连接 Relay。',
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function registerDevice(input: {
  relayUrl: string;
  deviceId: string;
  deviceSecret?: string;
  expoPushToken: string | null;
  platform: string;
}): Promise<DeviceRegistration> {
  return requestJson<DeviceRegistration>(
    `${normalizeRelayUrl(input.relayUrl)}/v1/devices/register`,
    {
      method: 'POST',
      headers: input.deviceSecret
        ? { Authorization: `Bearer ${input.deviceSecret}` }
        : undefined,
      body: JSON.stringify({
        device_id: input.deviceId,
        expo_push_token: input.expoPushToken,
        platform: input.platform,
      }),
    },
  );
}

export async function getDeviceStatus(
  relayUrl: string,
  deviceId: string,
  deviceSecret: string,
): Promise<DeviceStatus> {
  return requestJson<DeviceStatus>(
    `${normalizeRelayUrl(relayUrl)}/v1/devices/${encodeURIComponent(deviceId)}/status`,
    {
      headers: { Authorization: `Bearer ${deviceSecret}` },
    },
  );
}

export async function updateDevicePreferences(input: {
  relayUrl: string;
  deviceId: string;
  deviceSecret: string;
  preferences: Partial<DevicePreferences>;
}): Promise<DevicePreferences> {
  const response = await requestJson<{ preferences: DevicePreferences }>(
    `${normalizeRelayUrl(input.relayUrl)}/v1/devices/${encodeURIComponent(input.deviceId)}/preferences`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${input.deviceSecret}` },
      body: JSON.stringify(input.preferences),
    },
  );
  return response.preferences;
}

export async function getEvents(
  relayUrl: string,
  deviceId: string,
  deviceSecret: string,
  after: number,
): Promise<{ events: AgentEvent[]; next_cursor: number }> {
  return requestJson<{ events: AgentEvent[]; next_cursor: number }>(
    `${normalizeRelayUrl(relayUrl)}/v1/devices/${encodeURIComponent(deviceId)}/events?after=${after}`,
    {
      headers: { Authorization: `Bearer ${deviceSecret}` },
    },
  );
}

export async function getAgentSessions(
  relayUrl: string,
  deviceId: string,
  deviceSecret: string,
): Promise<AgentSession[]> {
  const response = await requestJson<{ sessions: AgentSession[] }>(
    `${normalizeRelayUrl(relayUrl)}/v1/devices/${encodeURIComponent(deviceId)}/sessions`,
    {
      headers: { Authorization: `Bearer ${deviceSecret}` },
    },
  );
  return response.sessions;
}

export async function getRemotePromptCommands(
  relayUrl: string,
  deviceId: string,
  deviceSecret: string,
): Promise<RemotePromptCommand[]> {
  const response = await requestJson<{ commands: RemotePromptCommand[] }>(
    `${normalizeRelayUrl(relayUrl)}/v1/devices/${encodeURIComponent(deviceId)}/remote-prompts`,
    {
      headers: { Authorization: `Bearer ${deviceSecret}` },
    },
  );
  return response.commands;
}

export async function sendRemotePrompt(input: {
  relayUrl: string;
  deviceId: string;
  deviceSecret: string;
  sessionRef: string;
  prompt: string;
  mode: RemotePromptMode;
  idempotencyKey: string;
}): Promise<RemotePromptCommand> {
  const response = await requestJson<{ command: RemotePromptCommand }>(
    `${normalizeRelayUrl(input.relayUrl)}/v1/devices/${encodeURIComponent(input.deviceId)}/remote-prompts`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.deviceSecret}` },
      body: JSON.stringify({
        session_ref: input.sessionRef,
        prompt: input.prompt,
        mode: input.mode,
        idempotency_key: input.idempotencyKey,
      }),
    },
  );
  return response.command;
}

export async function cancelRemotePrompt(
  relayUrl: string,
  deviceId: string,
  deviceSecret: string,
  commandId: string,
): Promise<RemotePromptCommand> {
  const response = await requestJson<{ command: RemotePromptCommand }>(
    `${normalizeRelayUrl(relayUrl)}/v1/devices/${encodeURIComponent(deviceId)}/remote-prompts/${encodeURIComponent(commandId)}/cancel`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceSecret}` },
      body: JSON.stringify({}),
    },
  );
  return response.command;
}

export async function acknowledgeEvent(
  relayUrl: string,
  deviceId: string,
  deviceSecret: string,
  eventId: string,
): Promise<void> {
  await requestJson(
    `${normalizeRelayUrl(relayUrl)}/v1/devices/${encodeURIComponent(deviceId)}/events/${encodeURIComponent(eventId)}/ack`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceSecret}` },
      body: JSON.stringify({}),
    },
  );
}

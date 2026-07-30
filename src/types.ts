export type AgentState =
  | 'working'
  | 'needs_you'
  | 'turn_finished'
  | 'subtask_completed'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'background_ended'
  | 'session_ended';

export interface AgentEvent {
  cursor: number;
  schema_version: '1.0';
  event_id: string;
  dedupe_key: string;
  occurred_at: string;
  source: 'codex';
  state: AgentState;
  event: string;
  project_alias: string;
  summary: string;
  session_ref?: string;
  acknowledged_at?: string;
}

export interface AgentPrompt {
  prompt_id: string;
  captured_at: string;
  text: string;
}

export interface AgentSession {
  session_ref: string;
  source: 'codex';
  project_alias: string;
  state: AgentState;
  summary: string;
  updated_at: string;
  last_event_at?: string;
  acknowledged_at?: string;
  prompts: AgentPrompt[];
  prompt_count: number;
  control_status?:
    | 'ready'
    | 'observe_only'
    | 'checking'
    | 'setup_required'
    | 'unsupported'
    | 'error';
}

export interface DeviceRegistration {
  device_id: string;
  device_secret: string;
  pairing_code: string | null;
  pairing_expires_at: string | null;
  paired: boolean;
}

export interface DeviceStatus {
  device_id: string;
  paired: boolean;
  pairing_code: string | null;
  pairing_expires_at: string | null;
  push_configured: boolean;
  web_push_configured?: boolean;
  preferences: DevicePreferences;
  remote_control?: RemoteControlHealth;
}

export type NotificationTone = 'calm' | 'direct' | 'playful';
export type NotificationLevel = 'decisions' | 'important' | 'all';

export interface DevicePreferences {
  notification_tone: NotificationTone;
  notification_level: NotificationLevel;
}

export interface RemoteControlHealth {
  state: 'disabled' | 'starting' | 'ready' | 'error';
  detail: string;
  endpoint: 'localhost-only' | null;
}

export type CodexControlAction =
  | 'status'
  | 'compact'
  | 'review'
  | 'interrupt';

export interface CodexModelOption {
  id: string;
  display_name: string;
  description: string;
  is_default: boolean;
  supported_efforts: string[];
  default_effort: string | null;
}

export interface CodexRateLimitWindow {
  used_percent: number;
  window_minutes: number | null;
  resets_at: string | null;
}

export interface CodexControlSnapshot {
  session_ref: string;
  control_status: 'ready';
  session_state: string;
  model: string | null;
  reasoning_effort: string | null;
  approval_policy: string;
  permission_profile: string;
  settings_apply_to: 'subsequent_turns';
  models: CodexModelOption[];
  rate_limit: {
    primary: CodexRateLimitWindow | null;
    secondary: CodexRateLimitWindow | null;
  } | null;
  available_actions: Record<CodexControlAction, boolean>;
  refreshed_at: string;
}

export interface CodexControlActionResult {
  action: CodexControlAction;
  accepted: boolean;
  detail: string;
  snapshot: CodexControlSnapshot;
}

export type CodexReplyHighlightKind =
  | 'outcome'
  | 'verification'
  | 'attention'
  | 'next'
  | 'detail';

export interface CodexReplyHighlight {
  kind: CodexReplyHighlightKind;
  label: string;
  text: string;
}

export interface CodexReplySummary {
  available: boolean;
  session_ref: string;
  current_turn_active: boolean;
  reason: string | null;
  turn_status: string | null;
  completed_at: string | null;
  headline: string | null;
  highlights: CodexReplyHighlight[];
  summary_method: 'local_extract';
  source_characters: number;
  source_truncated: boolean;
  raw_response_exposed: false;
  persisted: false;
  generated_at: string;
}

export type RemotePromptMode = 'queue' | 'steer';

export type RemotePromptStatus =
  | 'queued'
  | 'waiting'
  | 'dispatching'
  | 'sent'
  | 'failed'
  | 'canceled'
  | 'expired';

export interface RemotePromptCommand {
  command_id: string;
  session_ref: string;
  mode: RemotePromptMode;
  status: RemotePromptStatus;
  status_detail: string;
  created_at: string;
  expires_at: string;
  updated_at: string;
  prompt_length: number;
  turn_id?: string;
  error_code?: string;
}

export interface SavedDevice {
  deviceId: string;
  deviceSecret: string;
  relayUrl: string;
}

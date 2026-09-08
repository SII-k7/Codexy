export type WebPushPhase =
  | 'native'
  | 'insecure'
  | 'unsupported'
  | 'install-required'
  | 'ready'
  | 'subscribed'
  | 'expired'
  | 'denied'
  | 'error';

export interface WebPushStatus {
  phase: WebPushPhase;
  label: string;
  detail: string;
  canEnable: boolean;
}

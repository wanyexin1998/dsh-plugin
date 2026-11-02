export const CONNECTION_STATES = [
  'unlinked', 'authorizing', 'connected', 'reauth_required', 'org_cli_disabled',
  'app_permission_denied', 'identity_mismatch', 'user_cancelled', 'auth_timeout',
  'service_unavailable', 'unknown',
] as const;
export type ConnectionState = typeof CONNECTION_STATES[number];

export const REASON_CODES = [
  'not_connected', 'authorization_pending', 'authorization_expired', 'org_cli_disabled',
  'app_permission_denied', 'identity_mismatch', 'user_cancelled', 'auth_timeout',
  'service_unavailable', 'connection_unknown', 'backend_not_ready', 'unsupported_mode',
  'invalid_request', 'service_disposed',
] as const;
export type ReasonCode = typeof REASON_CODES[number];
export type BackendMode = 'local' | 'cellgent';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Public display information only. No IDs, profile paths, codes or credentials. */
export interface ConnectionStatus {
  state: ConnectionState;
  account?: { organizationName: string; displayName: string };
  capabilitySummary?: string[];
  checkedAt?: string;
  reasonCode?: ReasonCode;
}
export interface AuthorizationContext { sessionRef?: string; callRef?: string }
export interface AuthStart { transactionId: string; authorizeUrl: string; expiresAt: string }
export type InvokeInput =
  | { operationId: 'identity.getSelf'; args: Record<string, never> }
  | { operationId: 'calendar.listEvents'; args: { start?: string; end?: string; limit?: number; cursor?: string } }
  | { operationId: 'docs.search'; args: { query?: string; limit?: number; cursor?: string } };
export type InvokeResult =
  | { status: 'ok'; data: JsonValue }
  | { status: 'auth_required'; reasonCode: ReasonCode }
  | { status: 'denied' | 'failed'; reasonCode: ReasonCode; retryable: boolean };

export interface DingtalkConnectionService {
  status(): Promise<ConnectionStatus>;
  beginAuthorization(context: AuthorizationContext): Promise<AuthStart>;
  getAuthorizationStatus(transactionId: string): Promise<ConnectionStatus>;
  disconnect(): Promise<{ disconnected: boolean }>;
  invoke(input: InvokeInput): Promise<InvokeResult>;
}

/** Trusted adapter seam. Only the Host selects/owns it; never sent to the Client. */
export interface DingtalkBackend extends DingtalkConnectionService {
  readonly mode: BackendMode;
  dispose(): void | Promise<void>;
}

export class ConnectionServiceError extends Error {
  constructor(public readonly reasonCode: ReasonCode) {
    super(`DingTalk connection: ${reasonCode}`);
    this.name = 'ConnectionServiceError';
  }
}

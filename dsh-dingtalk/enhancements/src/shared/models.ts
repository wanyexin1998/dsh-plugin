export const CONNECTION_STATES = [
  'unlinked', 'authorizing', 'connected', 'reauth_required', 'org_cli_disabled',
  'app_permission_denied', 'identity_mismatch', 'user_cancelled', 'auth_timeout',
  'service_unavailable', 'unknown',
] as const;
export type ConnectionState = typeof CONNECTION_STATES[number];

export const REASON_CODES = [
  'not_connected', 'authorization_pending', 'authorization_expired', 'org_cli_disabled',
  'app_permission_denied', 'identity_mismatch', 'user_cancelled', 'auth_timeout',
  'service_unavailable', 'connection_unknown', 'token_exchange_failed', 'backend_not_ready', 'unsupported_mode',
  'invalid_request', 'service_disposed',
  'cli_missing', 'cli_integrity_failed', 'cli_version_unsupported', 'cli_platform_unsupported',
  'cli_download_failed', 'cli_download_timeout',
  'local_configuration_invalid', 'execution_timeout', 'execution_cancelled', 'queue_full',
  'queue_timeout', 'output_limit_exceeded', 'invalid_cli_output', 'cli_failed',
  'business_verification_required', 'token_refresh_pending',
  'oauth_not_configured', 'invalid_auth_state', 'authorization_busy', 'revocation_failed',
  'privacy_guard_required', 'verification_failed_after_save', 'rate_limited',
  'org_policy_denied', 'scope_authorization_required', 'permission_denied',
  'connection_preparing', 'unknown_command', 'command_unavailable', 'host_managed_operation', 'confirmation_required', 'confirmation_rejected', 'file_access_denied', 'job_not_found', 'job_limit', 'outcome_unknown',
] as const;
export type ReasonCode = typeof REASON_CODES[number];
export type BackendMode = 'local' | 'connector' | 'cellgent';
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
export interface ComponentProgress { phase: 'download' | 'verify'; received: number; total: number }
export interface PreparationStatus {
  state: 'idle' | 'running' | 'ready' | 'failed' | 'cancelled';
  progress?: ComponentProgress | undefined;
  reasonCode?: ReasonCode | undefined;
}
/** Host operational cancellation; never part of the model/JSON arguments. */
export interface CallOptions {
  signal?: AbortSignal;
  /** Trusted Host context, never accepted from tool JSON. */
  sessionId?: string;
  workingDirectory?: string;
  approve?: (summary: string) => Promise<boolean>;
}
export type DwsInput =
  | { operationId: 'dws.catalog'; args: { product?: string; query?: string; offset?: number; limit?: number } }
  | { operationId: 'dws.describe'; args: { command: string } }
  | { operationId: 'dws.execute'; args: { command: string; parameters: Record<string, JsonValue>; background?: boolean } }
  | { operationId: 'dws.jobs'; args: { action: 'list' | 'read' | 'stop'; jobId?: string; cursor?: number } };
export type InvokeInput = DwsInput
  | { operationId: 'identity.getSelf'; args: Record<string, never> }
  | { operationId: 'calendar.listEvents'; args: { start?: string; end?: string; limit?: number; cursor?: string } }
  | { operationId: 'docs.search'; args: { query?: string; limit?: number; cursor?: string } };
export type InvokeResult =
  | { status: 'ok'; data: JsonValue }
  | { status: 'auth_required'; reasonCode: ReasonCode }
  | { status: 'denied' | 'failed'; reasonCode: ReasonCode; retryable: boolean };

export interface DingtalkConnectionService {
  status(options?: CallOptions): Promise<ConnectionStatus>;
  beginAuthorization(context: AuthorizationContext, options?: CallOptions): Promise<AuthStart>;
  getAuthorizationStatus(transactionId: string): Promise<ConnectionStatus>;
  disconnect(): Promise<{ disconnected: boolean }>;
  invoke(input: InvokeInput, options?: CallOptions): Promise<InvokeResult>;
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

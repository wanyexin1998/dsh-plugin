import type { InvokeInput, JsonValue } from './models.js';
import { ConnectionServiceError } from './models.js';

/** Host/Connector wire protocol. Bump on any incompatible request or response change. */
export const CONNECTOR_PROTOCOL = 1;
export const CONNECTOR_ROUTES = Object.freeze({
  status: '/v1/status',
  prepare: '/v1/prepare',
  identity: '/v1/identity',
  authorizationBegin: '/v1/authorization/begin',
  authorizationStatus: '/v1/authorization/status',
  authorizationCancel: '/v1/authorization/cancel',
  invoke: '/v1/invoke',
  disconnect: '/v1/disconnect',
  health: '/v1/health',
  adminHealth: '/admin/v1/health',
  adminBindTestIdentity: '/admin/v1/test-identity',
  adminRemoveBinding: '/admin/v1/bindings/remove',
  adminRevoke: '/admin/v1/revoke',
  adminCallers: '/admin/v1/callers',
});
/** The only DWS operations a server-side caller may request in this delivery. */
export const SERVER_OPERATIONS = Object.freeze(['identity.getSelf', 'calendar.listEvents', 'docs.search'] as const);
export type ServerOperation = typeof SERVER_OPERATIONS[number];
export function isServerOperation(value: unknown): value is ServerOperation {
  return typeof value === 'string' && (SERVER_OPERATIONS as readonly string[]).includes(value);
}
/** Fail closed before a Connector call or DWS process for anything outside the server allowlist. */
export function assertServerOperation(value: unknown): ServerOperation {
  if (!isServerOperation(value)) throw new ConnectionServiceError('command_unavailable');
  return value;
}
const CALLER = /^[a-z0-9][a-z0-9-]{1,62}$/;
export function parseCallerId(value: unknown): string {
  if (typeof value !== 'string' || !CALLER.test(value)) throw new ConnectionServiceError('invalid_request');
  return value;
}
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function parseProfile(value: unknown): { corpId: string; userId: string } {
  if (typeof value !== 'string' || !PROFILE.test(value)) throw new ConnectionServiceError('invalid_request');
  const [corpId, userId] = value.split(':') as [string, string];
  return { corpId, userId };
}
export type ConnectorResponse<T> = { ok: true; value: T } | { ok: false; error: { code: string } };
export interface ConnectorIdentity { corpId: string; userId: string }
export interface ConnectorInvokeRequest { operationId: string; args: Record<string, JsonValue> }
export interface ConnectorPrepareValue { state: 'ready' | 'failed' | 'running'; reasonCode?: string; callbackOrigin?: string; protocol: number }
export interface ConnectorHealthValue { ok: boolean; protocol: number; version: string; oauth: boolean; callers: number; callbackOrigin?: string }
export interface ConnectorIdentityValue { identity: ConnectorIdentity | null; state: string }
export interface ConnectorAuthorizeStart { transactionId: string; authorizeUrl: string; expiresAt: string }
export interface ConnectorAuthorizeStatusValue { state: string; reasonCode?: string }
export interface ConnectorCallersValue { callers: { callerId: string; state: string; bound: boolean }[] }
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Shared argument check so both sides reject unknown identity/credential fields identically. */
export function assertNoIdentityFields(value: Record<string, unknown>): void {
  const forbidden = ['userId', 'corpId', 'profile', 'token', 'code', 'cookie', 'authorization', 'argv', 'path', 'url', 'home', 'keychain', 'configDirectory', 'binaryPath'];
  if (Object.keys(value).some(key => forbidden.some(item => item.toLowerCase() === key.toLowerCase()))) throw new ConnectionServiceError('invalid_request');
}
export type ConnectorInvokeInput = Extract<InvokeInput, { operationId: ServerOperation }>;

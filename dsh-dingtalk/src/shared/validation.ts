import { CONNECTION_STATES, REASON_CODES, ConnectionServiceError } from './models.js';
import type { AuthorizationContext, AuthStart, ConnectionStatus, InvokeInput, InvokeResult, JsonValue, ReasonCode } from './models.js';

const invalid = (): never => { throw new ConnectionServiceError('invalid_request'); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const data = record(value);
  if (Object.keys(data).some(key => !keys.includes(key))) return invalid();
  return data;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) return invalid();
  return value;
}
function date(value: unknown): string {
  const result = text(value, 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(result);
  if (!match || !Number.isFinite(Date.parse(result))) return invalid();
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!maxDay || day < 1 || day > maxDay) return invalid();
  return result;
}
export function transactionId(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(result)) return invalid();
  return result;
}
function reason(value: unknown): ReasonCode {
  if (!(REASON_CODES as readonly unknown[]).includes(value)) return invalid();
  return value as ReasonCode;
}
export function parseAuthorizationContext(value: unknown): AuthorizationContext {
  const data = exact(value, ['sessionRef', 'callRef']);
  const output: AuthorizationContext = {};
  for (const key of ['sessionRef', 'callRef'] as const) if (data[key] !== undefined) output[key] = text(data[key], 200);
  return output;
}
export function parseInvokeInput(value: unknown): InvokeInput {
  const data = exact(value, ['operationId', 'args']);
  if (data.operationId === 'identity.getSelf') {
    exact(data.args, []);
    return { operationId: data.operationId, args: {} };
  }
  if (data.operationId !== 'calendar.listEvents' && data.operationId !== 'docs.search') return invalid();
  const calendar = data.operationId === 'calendar.listEvents';
  const args = exact(data.args, calendar ? ['start', 'end', 'limit', 'cursor'] : ['query', 'limit', 'cursor']);
  const output: Record<string, string | number> = {};
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > (calendar ? 100 : 30)) return invalid();
    output.limit = args.limit;
  }
  if (args.cursor !== undefined) output.cursor = text(args.cursor, 2048);
  if (args.query !== undefined) output.query = text(args.query, 1000);
  if (args.start !== undefined) output.start = date(args.start);
  if (args.end !== undefined) output.end = date(args.end);
  if (typeof output.start === 'string' && typeof output.end === 'string' && Date.parse(output.start) >= Date.parse(output.end)) return invalid();
  return { operationId: data.operationId, args: output } as InvokeInput;
}

// Allowlisted projections discard backend-private fields instead of spreading DTOs.
export function publicStatus(value: unknown): ConnectionStatus {
  const data = record(value);
  if (!(CONNECTION_STATES as readonly unknown[]).includes(data.state)) return invalid();
  const result: ConnectionStatus = { state: data.state as ConnectionStatus['state'] };
  if (data.reasonCode !== undefined) result.reasonCode = reason(data.reasonCode);
  if (data.checkedAt !== undefined) result.checkedAt = date(data.checkedAt);
  if (data.account !== undefined) {
    const account = record(data.account);
    result.account = { organizationName: text(account.organizationName, 120), displayName: text(account.displayName, 120) };
  }
  if (data.capabilitySummary !== undefined) {
    if (!Array.isArray(data.capabilitySummary) || data.capabilitySummary.length > 20) return invalid();
    result.capabilitySummary = data.capabilitySummary.map(value => text(value, 120));
  }
  return result;
}
export function publicAuthStart(value: unknown): AuthStart {
  const data = record(value);
  const authorizeUrl = text(data.authorizeUrl, 4096);
  const url = new URL(authorizeUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return invalid();
  for (const key of url.searchParams.keys()) {
    if (/^(code|authcode|token|accesstoken|refreshtoken|clientsecret|appsecret)$/i.test(key.replaceAll('_', '').replaceAll('-', ''))) return invalid();
  }
  return { transactionId: transactionId(data.transactionId), authorizeUrl, expiresAt: date(data.expiresAt) };
}
function publicJson(value: unknown, budget: { nodes: number }, depth = 0): JsonValue {
  if (++budget.nodes > 10000 || depth > 32) return invalid();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => publicJson(item, budget, depth + 1));
  const data = record(value);
  const entries = Object.entries(data);
  if (entries.some(([key]) => /^(accessToken|refreshToken|appSecret|clientSecret|authCode|cookie|authorization|credentialPath|profileRef)$/i.test(key.replaceAll('_', '').replaceAll('-', '')))) return invalid();
  return Object.fromEntries(entries.map(([key, item]) => [key, publicJson(item, budget, depth + 1)]));
}
export function publicInvokeResult(value: unknown): InvokeResult {
  const data = record(value);
  if (data.status === 'ok') return { status: 'ok', data: publicJson(data.data, { nodes: 0 }) };
  if (data.status === 'auth_required') return { status: 'auth_required', reasonCode: reason(data.reasonCode) };
  if ((data.status === 'denied' || data.status === 'failed') && typeof data.retryable === 'boolean') {
    return { status: data.status, reasonCode: reason(data.reasonCode), retryable: data.retryable };
  }
  return invalid();
}

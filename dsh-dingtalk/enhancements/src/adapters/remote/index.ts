import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute } from 'node:path';
import { ConnectionServiceError, REASON_CODES } from '../../shared/models.js';
import type { AuthorizationContext, CallOptions, ConnectionStatus, DingtalkBackend, InvokeInput, InvokeResult, PreparationStatus, ReasonCode } from '../../shared/models.js';
import { parseInvokeInput, publicAuthStart, publicInvokeResult, publicStatus, transactionId } from '../../shared/validation.js';
import { CONNECTOR_PROTOCOL, CONNECTOR_ROUTES, isJsonObject } from '../../shared/connector.js';
import type { ConnectorAuthorizeStart, ConnectorHealthValue, ConnectorIdentityValue, ConnectorPrepareValue } from '../../shared/connector.js';
import type { ExecutionLimits } from '../../shared/config.js';
import { discover, describe } from '../../catalog/index.js';
import { ConnectorClient } from './client.js';
import type { RemoteEndpoint } from './client.js';
import type { ManagedConnection } from '../../host/managed-connection.js';
import type { BrowserContext } from '../../host/oauth.js';

export interface RemoteSettings {
  endpoint: RemoteEndpoint;
  trustedOrigins: string[];
  testTransport: boolean;
}
function origin(value: string, testTransport: boolean): string {
  const url = new URL(value);
  const loopbackHttp = testTransport && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('invalid trusted origin');
  return url.origin;
}
/** Host-only remote settings. They arrive from the deployment environment, never from plugin config JSON. */
export function parseRemoteSettings(env: NodeJS.ProcessEnv = process.env): RemoteSettings {
  const socketPath = env.DSH_DINGTALK_CONNECTOR_SOCKET;
  const baseUrl = env.DSH_DINGTALK_CONNECTOR_URL;
  const testTransport = env.DSH_DINGTALK_CONNECTOR_ALLOW_TEST_TRANSPORT === '1';
  let endpoint: RemoteEndpoint;
  if (socketPath) {
    if (!isAbsolute(socketPath) || /^(\\\\|\/\/)/.test(socketPath) || /[\u0000-\u001f]/.test(socketPath)) throw new ConnectionServiceError('local_configuration_invalid');
    endpoint = { socketPath };
  } else if (baseUrl) {
    if (!testTransport) throw new ConnectionServiceError('local_configuration_invalid');
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new ConnectionServiceError('local_configuration_invalid');
    const tokenFile = env.DSH_DINGTALK_CONNECTOR_TOKEN_FILE;
    if (!tokenFile || !isAbsolute(tokenFile) || /^(\\\\|\/\/)/.test(tokenFile)) throw new ConnectionServiceError('local_configuration_invalid');
    endpoint = { host: url.hostname, port: Number(url.port), tokenFile };
  } else throw new ConnectionServiceError('backend_not_ready');
  const trusted = (env.DSH_DINGTALK_TRUSTED_ORIGINS ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (trusted.length === 0 || trusted.length > 16) throw new ConnectionServiceError('local_configuration_invalid');
  return { endpoint, trustedOrigins: [...new Set(trusted.map(item => origin(item, testTransport)))], testTransport };
}
function browserContext(input: unknown, settings: RemoteSettings): BrowserContext {
  if (!isJsonObject(input)) throw new ConnectionServiceError('invalid_request');
  if (Object.keys(input).some(key => !['origin', 'returnPath'].includes(key)) || typeof input.origin !== 'string' || typeof input.returnPath !== 'string' || input.returnPath.length > 2048) throw new ConnectionServiceError('invalid_request');
  if (!settings.trustedOrigins.includes(input.origin)) throw new ConnectionServiceError('invalid_request');
  if (!input.returnPath.startsWith('/') || input.returnPath.startsWith('//') || /[\\\u0000-\u001f]/.test(input.returnPath)) throw new ConnectionServiceError('invalid_request');
  const originUrl = new URL(input.origin);
  const back = new URL(input.returnPath, originUrl);
  if (back.origin !== originUrl.origin || back.username || back.password) throw new ConnectionServiceError('invalid_request');
  if ([...back.searchParams.keys()].some(key => /token|code|secret|state/i.test(key)) || /[#?&](?:token|code|authCode|secret|state)=/i.test(back.hash)) throw new ConnectionServiceError('invalid_request');
  return { origin: originUrl.origin, returnPath: back.pathname + back.search + back.hash };
}
const failure = (error: unknown): ConnectionStatus => ({ state: 'unknown', reasonCode: error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable' });
const reasonCodeOf = (value: unknown): ReasonCode | undefined => (REASON_CODES as readonly string[]).includes(value as string) ? value as ReasonCode : undefined;
interface UIContext { browser: string; context: BrowserContext }

/** RemoteBackend: same ConnectionService contract as the local backend, over the Connector channel. */
export async function createRemoteConnection(settings: RemoteSettings, limits: ExecutionLimits): Promise<ManagedConnection> {
  const client = new ConnectorClient(settings.endpoint, Math.min(120000, Math.max(15000, limits.timeoutMs + 10000)));
  const ui = new AsyncLocalStorage<UIContext>();
  let closed = false;
  let revision = 0;
  let lastState: string | undefined;
  let identity: { corpId: string; userId: string } | undefined;
  let callbackOrigin: string | undefined;
  let preparation: PreparationStatus = { state: 'idle' };
  let preparationTask: Promise<void> | undefined;
  const startup = client.call<ConnectorHealthValue>(CONNECTOR_ROUTES.health, undefined).then(value => {
    if (!value || value.protocol !== CONNECTOR_PROTOCOL) throw new ConnectionServiceError('backend_not_ready');
    if (typeof value.callbackOrigin === 'string') callbackOrigin = value.callbackOrigin;
  });
  startup.catch(() => {});
  const ready = async (): Promise<void> => {
    if (closed) throw new ConnectionServiceError('service_disposed');
    try { await startup; } catch (error) { throw new ConnectionServiceError(error instanceof ConnectionServiceError ? error.reasonCode : 'backend_not_ready'); }
  };
  const callStatus = async (call: CallOptions = {}): Promise<ConnectionStatus> => {
    await ready();
    const value = await client.call<{ status: ConnectionStatus; identity?: { corpId: string; userId: string } | null }>(CONNECTOR_ROUTES.status, {}, call.signal);
    const status = publicStatus(value.status);
    identity = value.identity && typeof value.identity.corpId === 'string' && typeof value.identity.userId === 'string' ? { corpId: value.identity.corpId, userId: value.identity.userId } : undefined;
    if (status.state !== lastState) { lastState = status.state; if (status.state === 'connected') revision++; }
    return status;
  };
  const invoke = async (input: InvokeInput, call: CallOptions = {}): Promise<InvokeResult> => {
    try {
      await ready();
      const request = parseInvokeInput(input);
      if (request.operationId === 'dws.catalog') return { status: 'ok', data: discover(request.args) };
      if (request.operationId === 'dws.describe') return { status: 'ok', data: describe(request.args.command) };
      if (request.operationId !== 'identity.getSelf' && request.operationId !== 'calendar.listEvents' && request.operationId !== 'docs.search')
        return { status: 'denied', reasonCode: 'command_unavailable', retryable: false };
      const value = await client.call<{ result: InvokeResult }>(CONNECTOR_ROUTES.invoke, request, call.signal);
      return publicInvokeResult(value.result);
    } catch (error) {
      const reasonCode = error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable';
      if (['not_connected', 'authorization_expired', 'scope_authorization_required', 'authorization_pending'].includes(reasonCode)) return { status: 'auth_required', reasonCode };
      if (['identity_mismatch', 'command_unavailable', 'permission_denied', 'app_permission_denied', 'org_policy_denied', 'file_access_denied', 'host_managed_operation'].includes(reasonCode)) return { status: 'denied', reasonCode, retryable: false };
      return { status: 'failed', reasonCode, retryable: reasonCode === 'service_unavailable' };
    }
  };
  const backend: DingtalkBackend = {
    mode: 'connector',
    async status(call) {
      try { return await callStatus(call); } catch (error) { return failure(error); }
    },
    async beginAuthorization(context: AuthorizationContext, call: CallOptions = {}) {
      await ready();
      const caller = ui.getStore();
      if (!caller) throw new ConnectionServiceError('invalid_request');
      const context2 = browserContext({ origin: caller.context.origin, returnPath: caller.context.returnPath }, settings);
      const value = await client.call<ConnectorAuthorizeStart>(CONNECTOR_ROUTES.authorizationBegin, context2, call.signal);
      revision++;
      return publicAuthStart({ transactionId: value.transactionId, authorizeUrl: value.authorizeUrl, expiresAt: value.expiresAt });
    },
    async getAuthorizationStatus(id: string) {
      await ready();
      try {
        const value = await client.call<{ status: ConnectionStatus }>(CONNECTOR_ROUTES.authorizationStatus, { transactionId: transactionId(id) });
        return publicStatus(value.status);
      } catch (error) {
        if (error instanceof ConnectionServiceError && error.reasonCode === 'invalid_auth_state') throw error;
        return failure(error);
      }
    },
    async invoke(input, call) { return invoke(input, call); },
    async disconnect() {
      await ready();
      if (!ui.getStore()) throw new ConnectionServiceError('invalid_request');
      const value = await client.call<{ disconnected: boolean }>(CONNECTOR_ROUTES.disconnect, {});
      identity = undefined;
      revision++;
      return { disconnected: value.disconnected === true };
    },
    async dispose() { closed = true; },
  };
  const startPreparation = (): PreparationStatus => {
    if (!ui.getStore()) throw new ConnectionServiceError('invalid_request');
    if (preparation.state === 'running') return { state: 'running' };
    preparation = { state: 'running' };
    preparationTask = (async () => {
      try {
        const value = await client.call<ConnectorPrepareValue>(CONNECTOR_ROUTES.prepare, {});
        if (typeof value.callbackOrigin === 'string') callbackOrigin = value.callbackOrigin;
        if (value.state === 'ready') preparation = { state: 'ready' };
        else preparation = { state: 'failed', reasonCode: reasonCodeOf(value.reasonCode) ?? 'service_unavailable' };
      } catch (error) {
        preparation = { state: 'failed', reasonCode: error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable' };
      }
    })();
    return { state: 'running' };
  };
  return {
    backend,
    async invokeFor(principal, input, call) {
      const current = identity;
      if (!current || current.corpId !== principal.corpId || current.userId !== principal.userId) return { status: 'denied', reasonCode: 'identity_mismatch', retryable: false };
      return invoke(input, call);
    },
    ui: (browser, context, action) => ui.run({ browser, context }, action),
    cancel: (id, browser) => { void browser; void client.call(CONNECTOR_ROUTES.authorizationCancel, { transactionId: transactionId(id) }).catch(() => {}); return { state: 'unknown', reasonCode: 'connection_unknown' }; },
    prepareStart: startPreparation,
    prepareStatus: () => ({ ...preparation }),
    async prepareCancel() { preparation = { state: 'cancelled', reasonCode: 'user_cancelled' }; await preparationTask?.catch(() => {}); return { ...preparation }; },
    revision: () => revision,
    identity: () => identity,
    async callbackOriginReady() { try { await startup; } catch { /* offline is handled by status */ } return callbackOrigin; },
    get callbackOrigin() { return callbackOrigin; },
  };
}
function offlineConnection(reasonCode: ReasonCode): ManagedConnection {
  const unavailable = (): never => { throw new ConnectionServiceError(reasonCode); };
  const backend: DingtalkBackend = {
    mode: 'connector',
    async status() { return { state: 'unknown', reasonCode }; },
    beginAuthorization: unavailable,
    async getAuthorizationStatus() { return { state: 'unknown', reasonCode }; },
    async invoke() { return { status: 'failed', reasonCode, retryable: true }; },
    async disconnect() { return { disconnected: false }; },
    async dispose() { /* no channel */ },
  };
  return {
    backend,
    async invokeFor() { return { status: 'failed', reasonCode, retryable: true }; },
    ui: (_browser, _context, action) => action(),
    cancel: () => ({ state: 'unknown', reasonCode }),
    prepareStart() { return { state: 'failed', reasonCode }; },
    prepareStatus() { return { state: 'failed', reasonCode }; },
    async prepareCancel() { return { state: 'failed', reasonCode }; },
    revision: () => 0,
    identity: () => undefined,
  };
}
/** Host entry: a missing/offline Connector only disables DingTalk capabilities, never DSH itself. */
export async function createRemoteConnectionFor(env: NodeJS.ProcessEnv, limits: ExecutionLimits): Promise<ManagedConnection> {
  try { return await createRemoteConnection(parseRemoteSettings(env), limits); }
  catch (error) { return offlineConnection(error instanceof ConnectionServiceError ? error.reasonCode : 'backend_not_ready'); }
}

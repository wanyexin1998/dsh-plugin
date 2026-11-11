import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute } from 'node:path';
import { ConnectionServiceError, REASON_CODES } from '../../shared/models.js';
import type { AuthorizationContext, CallOptions, ConnectionStatus, DingtalkBackend, InvokeInput, InvokeResult, PreparationStatus, ReasonCode } from '../../shared/models.js';
import { parseInvokeInput, publicAuthStart, publicInvokeResult, publicStatus, transactionId } from '../../shared/validation.js';
import { CONNECTOR_PROTOCOL, CONNECTOR_ROUTES, isJsonObject, isServerOperation, parseOptionalSessionId, parseProfile } from '../../shared/connector.js';
import type { ConnectorAuthorizeStart, ConnectorHealthValue, ConnectorIdentityValue, ConnectorPrepareValue } from '../../shared/connector.js';
import type { ExecutionLimits } from '../../shared/config.js';
import { discover, describe } from '../../catalog/index.js';
import { hostApproval } from '../local/command.js';
import { ConnectorClient } from './client.js';
import type { RemoteEndpoint } from './client.js';
import type { ManagedConnection } from '../../host/managed-connection.js';
import type { BrowserContext } from '../../host/oauth.js';

export interface RemoteSettings {
  seatIdentity?: { corpId: string; userId: string };
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
  const seatIdentity = env.CELLGENT_DINGTALK_USER_ID === undefined ? undefined :
    parseProfile(`${env.CELLGENT_DINGTALK_CORP_ID ?? ''}:${env.CELLGENT_DINGTALK_USER_ID}`);
  return { ...(seatIdentity ? { seatIdentity } : {}), endpoint, trustedOrigins: [...new Set(trusted.map(item => origin(item, testTransport)))], testTransport };
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
  let preparationGeneration = 0;
  let preparationTask: { generation: number; controller: AbortController; promise: Promise<void> } | undefined;
  // Readiness is re-probeable: a failed health check must not poison this connection forever.
  let probing: Promise<void> | undefined;
  let verified = false;
  const invalidate = (): void => { verified = false; };
  const probe = (): Promise<void> => {
    if (closed) return Promise.reject(new ConnectionServiceError('service_disposed'));
    if (verified) return Promise.resolve();
    if (probing) return probing;
    probing = (async () => {
      try {
        const value = await client.call<ConnectorHealthValue>(CONNECTOR_ROUTES.health, undefined);
        if (closed) throw new ConnectionServiceError('service_disposed');
        if (!value || value.protocol !== CONNECTOR_PROTOCOL) throw new ConnectionServiceError('backend_not_ready');
        if (typeof value.callbackOrigin === 'string') callbackOrigin = value.callbackOrigin;
        verified = true;
      } finally { probing = undefined; }
    })();
    return probing;
  };
  const call = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    try { return await client.call<T>(path, body, signal); }
    catch (error) {
      if (error instanceof ConnectionServiceError && ['service_unavailable', 'backend_not_ready'].includes(error.reasonCode)) invalidate();
      throw error;
    }
  };
  const ready = async (): Promise<void> => {
    if (closed) throw new ConnectionServiceError('service_disposed');
    try { await probe(); } catch (error) {
      throw new ConnectionServiceError(error instanceof ConnectionServiceError ? error.reasonCode : 'backend_not_ready');
    }
  };
  const readStatus = async (callOptions: CallOptions = {}) => {
    await ready();
    const value = await call<{ status: ConnectionStatus; identity?: { corpId: string; userId: string } | null }>(CONNECTOR_ROUTES.status, {}, callOptions.signal);
    const status = publicStatus(value.status);
    identity = value.identity && typeof value.identity.corpId === 'string' && typeof value.identity.userId === 'string' ? { corpId: value.identity.corpId, userId: value.identity.userId } : undefined;
    if (status.state !== lastState) { lastState = status.state; if (status.state === 'connected') revision++; }
    return { status, identity };
  };
  const invoke = async (input: InvokeInput, callOptions: CallOptions = {}, expectedProfile?: string): Promise<InvokeResult> => {
    try {
      await ready();
      const request = parseInvokeInput(input);
      if (request.operationId === 'dws.catalog') return { status: 'ok', data: discover(request.args) };
      if (request.operationId === 'dws.describe') return { status: 'ok', data: describe(request.args.command) };
      if (!isServerOperation(request.operationId)) return { status: 'denied', reasonCode: 'command_unavailable', retryable: false };
      let confirmed = false;
      if (request.operationId === 'dws.execute') {
        const decision = hostApproval(request.args);
        if (decision.needsApproval) {
          if (!callOptions.approve) return { status: 'denied', reasonCode: 'confirmation_required', retryable: false };
          if (!await callOptions.approve(decision.summary)) return { status: 'denied', reasonCode: 'confirmation_rejected', retryable: false };
          confirmed = true;
        }
      }
      const sessionId = parseOptionalSessionId(callOptions.sessionId);
      const value = await call<{ result: InvokeResult }>(CONNECTOR_ROUTES.invoke, {
        operationId: request.operationId,
        args: request.args,
        ...(sessionId ? { sessionId } : {}),
        ...(confirmed ? { confirmed: true } : {}),
        ...(expectedProfile ? { expectedProfile } : {}),
      }, callOptions.signal);
      return publicInvokeResult(value.result);
    } catch (error) {
      const reasonCode = error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable';
      if (['not_connected', 'authorization_expired', 'scope_authorization_required', 'authorization_pending'].includes(reasonCode)) return { status: 'auth_required', reasonCode };
      if (['identity_mismatch', 'command_unavailable', 'permission_denied', 'app_permission_denied', 'org_policy_denied', 'file_access_denied', 'host_managed_operation', 'confirmation_required', 'confirmation_rejected', 'job_not_found', 'job_limit'].includes(reasonCode)) return { status: 'denied', reasonCode, retryable: false };
      return { status: 'failed', reasonCode, retryable: reasonCode === 'service_unavailable' };
    }
  };
  const backend: DingtalkBackend = {
    mode: 'connector',
    async status(call) {
      try { return (await readStatus(call)).status; } catch (error) { return failure(error); }
    },
    async beginAuthorization(context: AuthorizationContext, callOptions: CallOptions = {}) {
      await ready();
      const caller = ui.getStore();
      if (!caller) throw new ConnectionServiceError('invalid_request');
      const context2 = browserContext({ origin: caller.context.origin, returnPath: caller.context.returnPath }, settings);
      const value = await call<ConnectorAuthorizeStart>(CONNECTOR_ROUTES.authorizationBegin, context2, callOptions.signal);
      revision++;
      return publicAuthStart({ transactionId: value.transactionId, authorizeUrl: value.authorizeUrl, expiresAt: value.expiresAt });
    },
    async getAuthorizationStatus(id: string) {
      await ready();
      try {
        const value = await call<{ status: ConnectionStatus }>(CONNECTOR_ROUTES.authorizationStatus, { transactionId: transactionId(id) });
        return publicStatus(value.status);
      } catch (error) {
        if (error instanceof ConnectionServiceError && error.reasonCode === 'invalid_auth_state') throw error;
        return failure(error);
      }
    },
    async invoke(input, callOptions) {
      const seat = settings.seatIdentity;
      return invoke(input, callOptions, seat ? `${seat.corpId}:${seat.userId}` : undefined);
    },
    async disconnect() {
      await ready();
      if (!ui.getStore()) throw new ConnectionServiceError('invalid_request');
      const value = await call<{ disconnected: boolean }>(CONNECTOR_ROUTES.disconnect, {});
      identity = undefined;
      revision++;
      return { disconnected: value.disconnected === true };
    },
    async dispose() {
      closed = true;
      // A detached prepare task must not write state after disposal: invalidate its generation,
      // abort the in-flight request and wait for the task to settle.
      preparationGeneration++;
      const task = preparationTask;
      preparationTask = undefined;
      if (preparation.state === 'running') preparation = { state: 'failed', reasonCode: 'service_disposed' };
      task?.controller.abort('execution_cancelled');
      await task?.promise.catch(() => {});
    },
  };
  const startPreparation = (): PreparationStatus => {
    if (closed) return { state: 'failed', reasonCode: 'service_disposed' };
    if (!ui.getStore()) throw new ConnectionServiceError('invalid_request');
    if (preparation.state === 'running' && preparationTask) return { state: 'running' };
    const generation = ++preparationGeneration;
    const controller = new AbortController();
    preparation = { state: 'running' };
    const promise = (async () => {
      try {
        const value = await call<ConnectorPrepareValue>(CONNECTOR_ROUTES.prepare, {}, controller.signal);
        if (generation !== preparationGeneration || preparation.state !== 'running') return;
        if (typeof value.callbackOrigin === 'string') callbackOrigin = value.callbackOrigin;
        if (value.state === 'ready') preparation = { state: 'ready' };
        else preparation = { state: 'failed', reasonCode: reasonCodeOf(value.reasonCode) ?? 'service_unavailable' };
      } catch (error) {
        if (generation !== preparationGeneration || preparation.state !== 'running') return;
        if (controller.signal.aborted) { preparation = { state: 'cancelled', reasonCode: 'user_cancelled' }; return; }
        preparation = { state: 'failed', reasonCode: error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable' };
      }
    })();
    preparationTask = { generation, controller, promise };
    return { state: 'running' };
  };
  return {
    backend,
    async invokeFor(principal, input, callOptions) {
      if (settings.seatIdentity && (settings.seatIdentity.corpId !== principal.corpId || settings.seatIdentity.userId !== principal.userId))
        return { status: 'denied', reasonCode: 'identity_mismatch', retryable: false };
      try {
        const { status, identity: current } = await readStatus(callOptions);
        if (status.state !== 'connected')
          return status.state === 'unlinked' ? { status: 'auth_required', reasonCode: 'not_connected' } : { status: 'failed', reasonCode: status.reasonCode ?? 'connection_unknown', retryable: false };
        if (!current || current.corpId !== principal.corpId || current.userId !== principal.userId) return { status: 'denied', reasonCode: 'identity_mismatch', retryable: false };
      } catch (error) {
        return { status: 'failed', reasonCode: error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable', retryable: true };
      }
      return invoke(input, callOptions, `${principal.corpId}:${principal.userId}`);
    },
    ui: (browser, context, action) => ui.run({ browser, context }, action),
    context: (input: unknown) => browserContext(input, settings),
    async cancel(id: string, browser: string) {
      void browser;
      await ready();
      const value = await call<{ status: ConnectionStatus }>(CONNECTOR_ROUTES.authorizationCancel, { transactionId: transactionId(id) });
      return publicStatus(value.status);
    },
    prepareStart: startPreparation,
    prepareStatus: () => ({ ...preparation }),
    async prepareCancel() {
      // Invalidate the old task generation before waiting so a late response can never overwrite it.
      preparationGeneration++;
      const task = preparationTask;
      preparationTask = undefined;
      preparation = { state: 'cancelled', reasonCode: 'user_cancelled' };
      task?.controller.abort('execution_cancelled');
      await task?.promise.catch(() => {});
      return { ...preparation };
    },
    revision: () => revision,
    identity: () => settings.seatIdentity ?? identity,
    async callbackOriginReady() {
      try { await ready(); } catch { /* offline is handled by status */ }
      return callbackOrigin;
    },
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

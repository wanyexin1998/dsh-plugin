import { AsyncLocalStorage } from 'node:async_hooks';
import type { DingtalkBackend, ConnectionStatus, InvokeInput, CallOptions } from '../shared/models.js';
import { ConnectionServiceError } from '../shared/models.js';
import type { ExecutionLimits } from '../shared/config.js';
import type { LocalSettings } from '../adapters/local/settings.js';
import type { LocalRuntime } from '../adapters/local/executor.js';
import { DwsExecutor } from '../adapters/local/executor.js';
import { ExecutionQueue } from '../adapters/local/queue.js';
import { createLocalBackend } from '../adapters/local/index.js';
import { BindingStore } from './binding-store.js';
import type { BindingRecord } from './binding-store.js';
import { OAuthController } from './oauth.js';
import type { BrowserContext } from './oauth.js';
import type { PrivateSettings } from './private-settings.js';
import { provisionPrivateRuntime, verifyPrivacyGuard } from './privacy.js';

interface UIContext { browser: string; context: BrowserContext }
export interface ManagedConnection {
  backend: DingtalkBackend;
  ui<T>(browser: string, context: BrowserContext, action: () => Promise<T>): Promise<T>;
  cancel(id: string, browser: string): ConnectionStatus;
  revision(): number;
  callbackOrigin?: string;
}
export async function createManagedConnection(local: LocalSettings, options: PrivateSettings, limits: ExecutionLimits,
  runtime: LocalRuntime = {}, providerForTest?: string): Promise<ManagedConnection> {
  const scope = new AsyncLocalStorage<UIContext>();
  let epoch = 0, closed = false, busy = false;
  let mutationTail = Promise.resolve();
  async function mutate<T>(action: () => Promise<T>): Promise<T> {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }
  const ui = <T>(browser: string, context: BrowserContext, action: () => Promise<T>) => scope.run({ browser, context }, action);
  if (!options.oauth || !options.stateDirectory) {
    const base = createLocalBackend(local, limits, runtime);
    return {
      ui, revision: () => epoch,
      cancel() { throw new ConnectionServiceError('oauth_not_configured'); },
      backend: { ...base,
        beginAuthorization: async () => { throw new ConnectionServiceError('oauth_not_configured'); },
        invoke: async () => local.binaryPath ? { status: 'auth_required', reasonCode: 'not_connected' } : { status: 'failed', reasonCode: 'cli_missing', retryable: false },
      },
    };
  }
  const config = options.oauth;
  const expected = `${config.expectedCorpId}:${config.expectedUserId}`;
  const directory = await provisionPrivateRuntime(options.stateDirectory);
  if (local.configDirectory && local.configDirectory !== directory) throw new ConnectionServiceError('privacy_guard_required');
  if (local.profile && local.profile !== expected) throw new ConnectionServiceError('identity_mismatch');
  const settings: LocalSettings = { ...local, configDirectory: directory };
  const store = new BindingStore(options.stateDirectory);
  let record = await store.read();
  if (record.profile && record.profile !== expected) throw new ConnectionServiceError('identity_mismatch');
  let reader: DingtalkBackend | undefined;
  const makeReader = () => createLocalBackend({ ...settings, profile: expected }, limits, runtime);
  if (!record.revoked && !record.verificationPending && record.profile) reader = makeReader();
  const control = new ExecutionQueue(limits);
  const executor = new DwsExecutor(settings, limits, runtime);
  async function save(value: BindingRecord): Promise<void> { await store.write(value); record = value; }
  const check = async (): Promise<void> => { if (closed) throw new ConnectionServiceError('service_disposed'); await verifyPrivacyGuard(directory); };
  async function status(call: CallOptions = {}): Promise<ConnectionStatus> {
    await check();
    if (busy) return { state: 'authorizing', reasonCode: 'authorization_pending' };
    if (record.revocationPending) return { state: 'unknown', reasonCode: 'revocation_failed' };
    if (record.verificationPending) return { state: 'unknown', reasonCode: 'verification_failed_after_save' };
    if (!reader) return { state: 'unlinked', reasonCode: 'not_connected' };
    let value = await reader.status(call);
    if (value.reasonCode === 'business_verification_required' || value.reasonCode === 'token_refresh_pending') {
      const read = await reader.invoke({ operationId: 'identity.getSelf', args: {} }, call);
      value = read.status === 'ok' ? await reader.status(call) : { state: 'unknown', reasonCode: read.reasonCode };
    }
    return value.state === 'connected' ? { ...value, account: { organizationName: '已验证企业', displayName: '已授权账号' } } : value;
  }
  const oauth = new OAuthController(config, {
    revision: () => epoch,
    async exchange(code, revision, signal) {
      return mutate(async () => {
      await check();
      if (busy || revision !== epoch) throw new ConnectionServiceError('invalid_auth_state');
      busy = true;
      let saved = false;
      const previous = record;
      try {
        await reader?.dispose(); reader = undefined;
        const result = await control.run(async inner => {
          await check();
          return executor.execute(['auth', 'exchange', '--code-stdin', `--client-id=${config.clientId}`, `--expected-corp-id=${config.expectedCorpId}`, `--expected-user-id=${config.expectedUserId}`, '--format=json'], inner, code);
        }, signal) as { success?: boolean; data?: { dwsProfile?: string; corpId?: string; userId?: string; clientId?: string } };
        saved = true;
        if (closed || revision !== epoch || signal.aborted) throw new ConnectionServiceError('invalid_auth_state');
        if (result.success !== true || result.data?.dwsProfile !== expected || result.data.corpId !== config.expectedCorpId || result.data.userId !== config.expectedUserId || result.data.clientId !== config.clientId) throw new ConnectionServiceError('identity_mismatch');
        const candidate = makeReader();
        reader = candidate;
        const verified = await candidate.invoke({ operationId: 'identity.getSelf', args: {} }, { signal });
        if (verified.status !== 'ok') throw new ConnectionServiceError(verified.reasonCode);
        if (closed || revision !== epoch || signal.aborted) throw new ConnectionServiceError('invalid_auth_state');
        const connected = await candidate.status();
        if (connected.state !== 'connected') throw new ConnectionServiceError('verification_failed_after_save');
        if (closed || revision !== epoch || signal.aborted) throw new ConnectionServiceError('invalid_auth_state');
        await save({ version: 1, revoked: false, profile: expected });
        epoch++;
        return { ...connected, account: { organizationName: '已验证企业', displayName: '已授权账号' } };
      } catch (error) {
        await reader?.dispose(); reader = undefined;
        if (!closed && revision === epoch) {
          if (saved) await save({ version: 1, revoked: false, profile: expected, verificationPending: true });
          else if (!previous.revoked && !previous.verificationPending && previous.profile) reader = makeReader();
        }
        if (saved) throw new ConnectionServiceError('verification_failed_after_save');
        throw error;
      } finally { busy = false; }
      });
    },
  }, Date.now, providerForTest);
  const backend: DingtalkBackend = {
    mode: 'local',
    async status(call) {
      try { return await status(call); }
      catch (error) { return { state: 'unknown', reasonCode: error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable' }; }
    },
    async beginAuthorization() {
      await check();
      const caller = scope.getStore();
      if (!caller) throw new ConnectionServiceError('invalid_request');
      return oauth.begin(caller.browser, caller.context);
    },
    async getAuthorizationStatus(id) {
      const caller = scope.getStore();
      if (!caller) throw new ConnectionServiceError('invalid_request');
      return oauth.status(id, caller.browser);
    },
    async invoke(input: InvokeInput, call: CallOptions = {}) {
      await check();
      if (busy || !reader || record.revoked || record.verificationPending || record.revocationPending) return { status: 'auth_required', reasonCode: busy ? 'authorization_pending' : 'not_connected' };
      return reader.invoke(input, call);
    },
    async disconnect() {
      if (!scope.getStore()) throw new ConnectionServiceError('invalid_request');
      await check();
      epoch++; oauth.invalidate();
      return mutate(async () => {
      await check();
      const old = reader; reader = undefined;
      await save({ version: 1, revoked: true, ...(record.profile ? { profile: record.profile } : {}), revocationPending: !!record.profile });
      await old?.dispose();
      if (record.profile) {
        try {
          await control.run(async signal => { await check(); return executor.execute(['auth', 'logout', `--profile=${expected}`, '--format=json'], signal, '', false); });
        } catch { throw new ConnectionServiceError('revocation_failed'); }
      }
      await save({ version: 1, revoked: true });
      return { disconnected: true };
      });
    },
    async dispose() { closed = true; epoch++; oauth.invalidate(); await control.dispose(); await reader?.dispose(); await mutationTail; await oauth.dispose(); },
  };
  return { backend, ui, revision: () => epoch, callbackOrigin: new URL(config.redirectUri).origin, cancel: (id, browser) => oauth.cancel(id, browser) };
}

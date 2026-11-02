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
import { ensureDws, officialClient } from './bootstrap.js';
import type { BootstrapRuntime } from './bootstrap.js';
import { defaultStateDirectory } from './private-settings.js';
import { discover, describe } from '../catalog/index.js';
import { join } from 'node:path';

interface UIContext { browser: string; context: BrowserContext }
export interface ManagedConnection {
  backend: DingtalkBackend;
  ui<T>(browser: string, context: BrowserContext, action: () => Promise<T>): Promise<T>;
  cancel(id: string, browser: string): ConnectionStatus;
  revision(): number;
  callbackOrigin?: string;
}
export async function createManagedConnection(local: LocalSettings, options: PrivateSettings, limits: ExecutionLimits,
  runtime: LocalRuntime & BootstrapRuntime = {}, providerForTest?: string): Promise<ManagedConnection> {
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
  const stateDirectory = options.stateDirectory || defaultStateDirectory();
  const config = options.oauth || { clientId: '', redirectUri: 'http://127.0.0.1:0/callback', scopes: 'openid corpid', expectedCorpId: '', expectedUserId: '' };
  let expected: string | undefined = options.oauth ? `${config.expectedCorpId}:${config.expectedUserId}` : local.profile;
  const directory = await provisionPrivateRuntime(stateDirectory);
  if (local.configDirectory && local.configDirectory !== directory) throw new ConnectionServiceError('privacy_guard_required');
  if (local.profile && expected && local.profile !== expected) throw new ConnectionServiceError('identity_mismatch');
  const autoInstall = !local.binaryPath;
  const settings: LocalSettings = { ...local, binaryPath: local.binaryPath || join(stateDirectory, 'bin', 'dws.exe'), configDirectory: directory };
  const store = new BindingStore(stateDirectory);
  let record = await store.read();
  if (record.profile && expected && record.profile !== expected) throw new ConnectionServiceError('identity_mismatch');
  expected = record.profile || expected;
  let reader: DingtalkBackend | undefined;
  const makeReader = (profile = expected) => {
    if (!profile) throw new ConnectionServiceError('identity_mismatch');
    return createLocalBackend({ ...settings, profile }, limits, runtime);
  };
  if (!record.revoked && !record.verificationPending && record.profile) reader = makeReader();
  const control = new ExecutionQueue(limits);
  const executor = new DwsExecutor(settings, limits, runtime);
  const lifetime = new AbortController();
  let preparing = false, preparation: Promise<void> | undefined, pendingProfile: string | undefined;
  async function save(value: BindingRecord): Promise<void> { await store.write(value); record = value; }
  const check = async (): Promise<void> => { if (closed) throw new ConnectionServiceError('service_disposed'); await verifyPrivacyGuard(directory); };
  async function prepare(signal?: AbortSignal) {
    if (!preparation) preparation = (async () => {
      preparing = true;
      const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
      try {
        if (autoInstall) await ensureDws(settings.binaryPath!, combined, runtime);
        await control.run(inner => executor.check(inner), combined);
        if (!config.clientId) config.clientId = await officialClient(combined, runtime);
        await check();
        if (combined.aborted) throw new ConnectionServiceError('execution_cancelled');
      } finally { preparing = false; }
    })().catch(error => { preparation = undefined; throw error; });
    await preparation;
    if (signal?.aborted) throw new ConnectionServiceError('execution_cancelled');
  }
  async function status(call: CallOptions = {}): Promise<ConnectionStatus> {
    await check();
    if (preparing) return { state: 'authorizing', reasonCode: 'connection_preparing' };
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
      let exchangedProfile: string | undefined;
      const previous = record;
      try {
        await reader?.dispose(); reader = undefined;
        const result = await control.run(async inner => {
          await check();
          const identity = expected?.split(':');
          return executor.execute(['auth', 'exchange', '--code-stdin', `--client-id=${config.clientId}`, ...(identity ? [`--expected-corp-id=${identity[0]}`, `--expected-user-id=${identity[1]}`] : []), '--format=json'], inner, code);
        }, signal) as { success?: boolean; data?: { dwsProfile?: string; corpId?: string; userId?: string; clientId?: string } };
        saved = true;
        const profile = result.data?.dwsProfile;
        if (result.success !== true || typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(profile) || profile !== `${result.data?.corpId}:${result.data?.userId}` || (expected && profile !== expected) || result.data?.clientId !== config.clientId) throw new ConnectionServiceError('identity_mismatch');
        exchangedProfile = profile; pendingProfile = profile;
        if (closed || revision !== epoch || signal.aborted) throw new ConnectionServiceError('invalid_auth_state');
        const candidate = makeReader(profile);
        reader = candidate;
        const verified = await candidate.invoke({ operationId: 'identity.getSelf', args: {} }, { signal });
        if (verified.status !== 'ok') throw new ConnectionServiceError(verified.reasonCode);
        if (closed || revision !== epoch || signal.aborted) throw new ConnectionServiceError('invalid_auth_state');
        const connected = await candidate.status();
        if (connected.state !== 'connected') throw new ConnectionServiceError('verification_failed_after_save');
        if (closed || revision !== epoch || signal.aborted) throw new ConnectionServiceError('invalid_auth_state');
        await save({ version: 1, revoked: false, profile }); expected = profile; pendingProfile = undefined;
        epoch++;
        return { ...connected, account: { organizationName: '已验证企业', displayName: '已授权账号' } };
      } catch (error) {
        await reader?.dispose(); reader = undefined;
        if (!closed && revision === epoch) {
          if (saved) { const profile = exchangedProfile || previous.profile; await save({ version: 1, revoked: !profile, ...(profile ? { profile } : {}), verificationPending: true }); expected = profile; }
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
    async beginAuthorization(_context, call: CallOptions = {}) {
      await check();
      const caller = scope.getStore();
      if (!caller) throw new ConnectionServiceError('invalid_request');
      if (busy) throw new ConnectionServiceError('authorization_busy');
      if (record.revocationPending) throw new ConnectionServiceError('revocation_failed');
      const revision = epoch;
      await prepare(call.signal);
      if (revision !== epoch) throw new ConnectionServiceError('invalid_auth_state');
      return oauth.begin(caller.browser, caller.context);
    },
    async getAuthorizationStatus(id) {
      const caller = scope.getStore();
      if (!caller) throw new ConnectionServiceError('invalid_request');
      return oauth.status(id, caller.browser);
    },
    async invoke(input: InvokeInput, call: CallOptions = {}) {
      await check();
      if (input.operationId === 'dws.catalog') return { status: 'ok', data: discover(input.args) };
      if (input.operationId === 'dws.describe') return { status: 'ok', data: describe(input.args.command) };
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
      const target = record.profile || pendingProfile;
      await save({ version: 1, revoked: true, ...(target ? { profile: target } : {}), revocationPending: !!target });
      await old?.dispose();
      if (target) {
        try {
          if (autoInstall) await ensureDws(settings.binaryPath!, lifetime.signal, runtime);
          await control.run(async signal => { await check(); return executor.execute(['auth', 'logout', `--profile=${target}`, '--format=json'], signal, '', false); });
        } catch { throw new ConnectionServiceError('revocation_failed'); }
      }
      await save({ version: 1, revoked: true });
      expected = options.oauth ? `${config.expectedCorpId}:${config.expectedUserId}` : undefined; pendingProfile = undefined;
      return { disconnected: true };
      });
    },
    async dispose() { closed = true; lifetime.abort(); epoch++; oauth.invalidate(); await preparation?.catch(() => {}); await control.dispose(); await reader?.dispose(); await mutationTail; await oauth.dispose(); },
  };
  return { backend, ui, revision: () => epoch, get callbackOrigin() { return oauth.origin; }, cancel: (id, browser) => oauth.cancel(id, browser) };
}

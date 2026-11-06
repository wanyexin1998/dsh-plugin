import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { ConnectionServiceError } from '../../enhancements/src/shared/models.js'
import type {
  CallOptions,
  ConnectionStatus,
  DingtalkBackend,
  InvokeInput,
  InvokeResult,
  JsonValue,
  PreparationStatus,
} from '../../enhancements/src/shared/models.js'
import type { ExecutionLimits } from '../../enhancements/src/shared/config.js'
import { createLocalBackend } from '../../enhancements/src/adapters/local/index.js'
import { DwsExecutor } from '../../enhancements/src/adapters/local/executor.js'
import { processEnvironment } from '../../enhancements/src/adapters/local/process.js'
import type { LocalSettings } from '../../enhancements/src/adapters/local/settings.js'
import { platformTarget, verifyExecutable } from '../../enhancements/src/adapters/local/executable.js'
import { BindingStore } from '../../enhancements/src/host/binding-store.js'
import type { BindingRecord } from '../../enhancements/src/host/binding-store.js'
import type { ConnectorConfig } from './config.js'
import type { ConnectorState, UserPaths } from './state.js'
import { CONNECTOR_PROTOCOL } from '../../enhancements/src/shared/connector.js'

export interface SessionBinding {
  corpId: string
  userId: string
}
export interface AuthorizationBridge {
  begin(
    callerId: string,
    origin: unknown,
    returnPath: unknown,
  ): { transactionId: string; authorizeUrl: string; expiresAt: string }
  status(callerId: string, transactionId: string): ConnectionStatus
  cancel(callerId: string, transactionId: string): ConnectionStatus
  invalidate(callerId: string): void
}
export interface PreparedValue {
  state: 'ready' | 'failed'
  reasonCode?: string
  callbackOrigin?: string
  protocol: number
}
const MAX_INFLIGHT = 8
const validProfile = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)

/**
 * One isolated server-side user. All DWS state lives under its own directory on the Connector
 * private volume: HOME, DWS_CONFIG_DIR, keychain, binding record and refresh lock.
 */
export class UserSession {
  private backend: DingtalkBackend | undefined
  private record: BindingRecord = { version: 1, revoked: true }
  private paths!: UserPaths
  private executor!: DwsExecutor
  private store!: BindingStore
  private inflight = new Set<AbortController>()
  private authorizing = false
  private closed = false
  private initialization: Promise<void> | undefined
  private mismatch = false
  private authorizationEpoch = 0
  private storageBlocked = false
  private lastPreparation: PreparationStatus = { state: 'idle' }
  constructor(
    private readonly config: ConnectorConfig,
    private readonly state: ConnectorState,
    readonly callerId: string,
    readonly binding: SessionBinding,
    private readonly auth: () => AuthorizationBridge | undefined,
  ) {}
  get profile(): string {
    return `${this.binding.corpId}:${this.binding.userId}`
  }
  async init(): Promise<void> {
    if (!this.initialization)
      this.initialization = this.initialize().catch((error) => {
        this.initialization = undefined
        throw error
      })
    await this.initialization
  }
  private async initialize(): Promise<void> {
    this.paths = await this.state.provisionUser(this.callerId)
    this.store = new BindingStore(this.paths.root)
    try {
      this.record = await this.store.read()
    } catch {
      this.record = { version: 1, revoked: true }
    }
    // A binding change must never reuse the token of a previously bound account.
    this.mismatch = !!this.record.profile && this.record.profile !== this.profile
    const pendingMarker = await this.state.hasRevocationPending(this.callerId).catch(() => false)
    if (pendingMarker && !this.record.revoked) {
      // A fallback marker records a revocation that could not be written into the caller
      // directory: never restore a usable authorization from the stale binding.
      this.record = {
        version: 1,
        revoked: true,
        ...(this.record.profile ? { profile: this.record.profile } : {}),
        revocationPending: true,
      }
    } else if (pendingMarker) {
      await this.state.clearRevocationPending(this.callerId).catch(() => {})
    }
    try {
      await this.state.assertCallerWritable(this.callerId)
    } catch {
      // Persistence is unavailable for this caller; block instead of trusting the old record.
      this.storageBlocked = true
    }
    const settings = this.settings()
    this.executor = new DwsExecutor(settings, this.config.limits, this.runtime())
    if (
      !this.storageBlocked &&
      !this.mismatch &&
      !this.record.revoked &&
      !this.record.verificationPending &&
      this.record.profile === this.profile
    )
      this.backend = this.createBackend()
  }
  private binaryPath(): string {
    // The replacement CLI exists only behind an explicit test mode; production always uses the pinned binary.
    return this.config.testDwsBinary ?? this.config.dwsBinary
  }
  private settings(): LocalSettings {
    return {
      binaryPath: this.binaryPath(),
      configDirectory: this.paths.dwsConfig,
      keychainDirectory: this.paths.keychain,
      profile: this.profile,
    }
  }
  private environment(): NodeJS.ProcessEnv {
    const env = processEnvironment(this.settings())
    env.HOME = this.paths.home
    env.USERPROFILE = this.paths.home
    env.DWS_CONFIG_DIR = this.paths.dwsConfig
    env.DWS_KEYCHAIN_DIR = this.paths.keychain
    env.DWS_NO_UPDATE_CHECK = '1'
    // Test-only seam: never populated unless the Connector runs in explicit test mode.
    if (this.config.testEnvironment) Object.assign(env, this.config.testEnvironment)
    if (this.config.proxy) {
      // Explicit egress configuration only. Never inherit ambient HTTP(S)_PROXY from the container.
      env.HTTPS_PROXY = this.config.proxy.https
      env.HTTP_PROXY = this.config.proxy.http
      env.https_proxy = this.config.proxy.https
      env.http_proxy = this.config.proxy.http
      if (this.config.proxy.noProxy) {
        env.NO_PROXY = this.config.proxy.noProxy
        env.no_proxy = this.config.proxy.noProxy
      }
    }
    return env
  }
  private runtime() {
    const environment = this.environment()
    return this.config.testDwsBinary ? { environment, verify: async () => this.config.testDwsBinary! } : { environment }
  }
  private createBackend(): DingtalkBackend {
    return createLocalBackend(this.settings(), this.config.limits, this.runtime())
  }
  async preparation(signal?: AbortSignal): Promise<PreparedValue> {
    const checkAborted = (): void => {
      if (signal?.aborted) throw new ConnectionServiceError('execution_cancelled')
    }
    const target = platformTarget()
    if (!target) return { state: 'failed', reasonCode: 'cli_platform_unsupported', protocol: CONNECTOR_PROTOCOL }
    if (this.mismatch) return { state: 'failed', reasonCode: 'identity_mismatch', protocol: CONNECTOR_PROTOCOL }
    if (this.storageBlocked) return { state: 'failed', reasonCode: 'service_unavailable', protocol: CONNECTOR_PROTOCOL }
    try {
      // A test-mode replacement CLI is a fixture, not a pinned artifact; production always verifies the hash.
      checkAborted()
      if (this.config.testDwsBinary) {
        await stat(this.config.testDwsBinary)
        await access(this.config.testDwsBinary, constants.X_OK)
      } else await verifyExecutable(this.config.dwsBinary, signal, target)
      checkAborted()
      await this.executor.check(signal ?? new AbortController().signal)
      checkAborted()
      this.lastPreparation = { state: 'ready' }
      return {
        state: 'ready',
        ...(this.config.oauth ? { callbackOrigin: this.config.oauth.publicOrigin } : {}),
        protocol: CONNECTOR_PROTOCOL,
      }
    } catch (error) {
      const reasonCode = error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable'
      this.lastPreparation = { state: 'failed', reasonCode }
      return { state: 'failed', reasonCode, protocol: CONNECTOR_PROTOCOL }
    }
  }
  preparationState(): PreparationStatus {
    return { ...this.lastPreparation }
  }
  async status(call: CallOptions = {}): Promise<ConnectionStatus> {
    const run = async (): Promise<ConnectionStatus> => {
      if (this.closed) return { state: 'unknown', reasonCode: 'service_disposed' }
      if (this.authorizing) return { state: 'authorizing', reasonCode: 'authorization_pending' }
      if (this.mismatch) return { state: 'identity_mismatch', reasonCode: 'identity_mismatch' }
      if (this.record.revocationPending) return { state: 'unknown', reasonCode: 'revocation_failed' }
      if (this.storageBlocked) return { state: 'unknown', reasonCode: 'service_unavailable' }
      if (this.record.verificationPending) return { state: 'unknown', reasonCode: 'verification_failed_after_save' }
      if (!this.backend) return { state: 'unlinked', reasonCode: 'not_connected' }
      let value = await this.backend.status(call)
      // A restart or an expired refresh token only proves local state; confirm online identity
      // before reporting connected, exactly like the local managed connection.
      if (value.reasonCode === 'business_verification_required' || value.reasonCode === 'token_refresh_pending') {
        const read = await this.backend.invoke({ operationId: 'identity.getSelf', args: {} }, call)
        value =
          read.status === 'ok' ? await this.backend.status(call) : { state: 'unknown', reasonCode: read.reasonCode }
      }
      return value.state === 'connected'
        ? { ...value, account: { organizationName: '已验证企业', displayName: '已授权账号' } }
        : value
    }
    return this.guard(run, call)
  }
  async identity(call: CallOptions = {}): Promise<{ identity: SessionBinding | null; state: string }> {
    const status = await this.status(call)
    const connected =
      status.state === 'connected' ||
      (status.state === 'unknown' &&
        ['business_verification_required', 'token_refresh_pending'].includes(status.reasonCode ?? ''))
    return connected && this.backend
      ? { identity: { ...this.binding }, state: status.state }
      : { identity: null, state: status.state }
  }
  async invoke(input: InvokeInput, call: CallOptions = {}): Promise<InvokeResult> {
    try {
      return await this.guard(async (inner): Promise<InvokeResult> => {
        if (this.closed) return { status: 'failed', reasonCode: 'service_disposed', retryable: false }
        if (this.mismatch) return { status: 'denied', reasonCode: 'identity_mismatch', retryable: false }
        if (this.storageBlocked) return { status: 'failed', reasonCode: 'service_unavailable', retryable: false }
        if (this.authorizing) return { status: 'auth_required', reasonCode: 'authorization_pending' }
        if (!this.backend) return { status: 'auth_required', reasonCode: 'not_connected' }
        return this.backend.invoke(input, inner)
      }, call)
    } catch (error) {
      const reasonCode = error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable'
      return {
        status: 'failed',
        reasonCode,
        retryable: reasonCode === 'queue_full' || reasonCode === 'service_unavailable',
      }
    }
  }
  private async guard<T>(action: (call: CallOptions) => Promise<T>, call: CallOptions): Promise<T> {
    if (this.closed) throw new ConnectionServiceError('service_disposed')
    if (this.inflight.size >= MAX_INFLIGHT) throw new ConnectionServiceError('queue_full')
    const controller = new AbortController()
    if (call.signal?.aborted) throw new ConnectionServiceError('execution_cancelled')
    const abort = () => controller.abort(call.signal?.reason)
    call.signal?.addEventListener('abort', abort, { once: true })
    this.inflight.add(controller)
    try {
      return await action({ ...call, signal: controller.signal })
    } finally {
      this.inflight.delete(controller)
      call.signal?.removeEventListener('abort', abort)
    }
  }
  beginAuthorization(origin: unknown, returnPath: unknown) {
    if (this.closed) throw new ConnectionServiceError('service_disposed')
    if (this.mismatch) throw new ConnectionServiceError('identity_mismatch')
    if (this.record.revocationPending) throw new ConnectionServiceError('revocation_failed')
    if (this.storageBlocked) throw new ConnectionServiceError('service_unavailable')
    if (this.authorizing) throw new ConnectionServiceError('authorization_busy')
    const bridge = this.auth()
    if (!bridge) throw new ConnectionServiceError('oauth_not_configured')
    return bridge.begin(this.callerId, origin, returnPath)
  }
  authorizationStatus(id: string): ConnectionStatus {
    const bridge = this.auth()
    if (!bridge) throw new ConnectionServiceError('oauth_not_configured')
    return bridge.status(this.callerId, id)
  }
  authorizationCancel(id: string): ConnectionStatus {
    const bridge = this.auth()
    if (!bridge) throw new ConnectionServiceError('oauth_not_configured')
    return bridge.cancel(this.callerId, id)
  }
  /** Called by the OAuth callback. Exchange code via stdin, then re-verify the bound identity. */
  async exchange(code: string, signal: AbortSignal): Promise<ConnectionStatus> {
    if (this.closed) throw new ConnectionServiceError('service_disposed')
    const oauth = this.config.oauth
    if (!oauth) throw new ConnectionServiceError('oauth_not_configured')
    this.authorizing = true
    const epoch = ++this.authorizationEpoch
    const previous = this.record
    try {
      return await this.state.withRefreshLock(this.callerId, async () => {
        await this.backend?.dispose()
        this.backend = undefined
        let attempted = false
        let exchanged = false
        try {
          if (this.stale(epoch, signal)) throw new ConnectionServiceError('execution_cancelled')
          // From here on the exchange subprocess may persist credentials before it returns: a
          // cancellation can no longer be treated as "nothing happened".
          attempted = true
          const result = (await this.executor.execute(
            [
              'auth',
              'exchange',
              '--code-stdin',
              `--client-id=${oauth.clientId}`,
              `--expected-corp-id=${this.binding.corpId}`,
              `--expected-user-id=${this.binding.userId}`,
              '--format=json',
            ],
            signal,
            code,
          )) as {
            success?: boolean
            data?: { dwsProfile?: string; corpId?: string; userId?: string; clientId?: string }
          }
          if (this.stale(epoch, signal)) throw new ConnectionServiceError('execution_cancelled')
          const profile = result?.data?.dwsProfile
          if (
            result?.success !== true ||
            !validProfile(profile) ||
            profile !== `${result.data?.corpId}:${result.data?.userId}` ||
            profile !== this.profile ||
            result.data?.clientId !== oauth.clientId
          )
            throw new ConnectionServiceError('identity_mismatch')
          // The exchange has persisted credentials for this profile. Any later cancellation or
          // failure must isolate them instead of silently restoring a usable authorization.
          exchanged = true
          this.record = { version: 1, revoked: false, profile }
          const candidate = this.createBackend()
          this.backend = candidate
          const verified = await candidate.invoke({ operationId: 'identity.getSelf', args: {} }, { signal })
          if (this.stale(epoch, signal)) throw new ConnectionServiceError('execution_cancelled')
          if (verified.status !== 'ok') throw new ConnectionServiceError(verified.reasonCode)
          const status = await candidate.status()
          if (this.stale(epoch, signal)) throw new ConnectionServiceError('execution_cancelled')
          if (status.state !== 'connected') throw new ConnectionServiceError('verification_failed_after_save')
          // Commit barrier: a cancellation observed here must win over persistence, and the same
          // check runs again after the write so a cancellation inside the write window also wins.
          await this.commitBarrier(epoch, signal)
          await this.store.write({ version: 1, revoked: false, profile })
          await this.commitBarrier(epoch, signal)
          return { ...status, account: { organizationName: '已验证企业', displayName: '已授权账号' } }
        } catch (error) {
          await this.backend?.dispose()
          this.backend = undefined
          const reasonCode = error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable'
          if (reasonCode === 'execution_cancelled') {
            if (attempted) await this.isolateCancelledExchange(this.profile)
            else if (this.recordUsable(previous)) this.backend = this.createBackend()
            throw new ConnectionServiceError('execution_cancelled')
          }
          if (exchanged) {
            // A saved exchange that cannot be verified or committed must never revive an account.
            this.record = {
              version: 1,
              revoked: false,
              profile: this.profile,
              verificationPending: true,
            }
            await this.store.write(this.record).catch(() => {})
            throw error instanceof ConnectionServiceError ? error : new ConnectionServiceError('service_unavailable')
          }
          if (this.recordUsable(previous)) this.backend = this.createBackend()
          throw error instanceof ConnectionServiceError ? error : new ConnectionServiceError('service_unavailable')
        }
      })
    } finally {
      this.authorizing = false
    }
  }
  /** Cancellation wins when the caller signal fired, the session closed or a newer exchange began. */
  private stale(epoch: number, signal: AbortSignal): boolean {
    return signal.aborted || this.closed || epoch !== this.authorizationEpoch
  }
  /**
   * Test-only barrier on the commit path. It lets the suite cancel exactly between verification and
   * persistence; the gate is parsed only in explicit test mode and is never set in production.
   */
  private async commitBarrier(epoch: number, signal: AbortSignal): Promise<void> {
    if (this.stale(epoch, signal)) throw new ConnectionServiceError('execution_cancelled')
    const gate = this.config.testCommitGate
    if (!gate) return
    const deadline = Date.now() + 15_000
    for (;;) {
      if (this.stale(epoch, signal)) throw new ConnectionServiceError('execution_cancelled')
      try {
        await stat(gate)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw new ConnectionServiceError('service_unavailable')
      }
      if (Date.now() > deadline) throw new ConnectionServiceError('execution_cancelled')
      await new Promise((done) => setTimeout(done, 10))
    }
  }
  private recordUsable(record: BindingRecord): boolean {
    return (
      !record.revoked && !record.verificationPending && !record.revocationPending && record.profile === this.profile
    )
  }
  /**
   * A cancelled exchange may already have persisted credentials. Remove them and persist a
   * revocation; if cleanup is unknown or fails, keep `revocationPending` so status stays blocked.
   */
  private async isolateCancelledExchange(profile: string): Promise<void> {
    this.backend = undefined
    const pending: BindingRecord = { version: 1, revoked: true, profile, revocationPending: true }
    this.record = pending
    await this.store.write(pending).catch(async () => {
      // The caller directory may be unwritable; keep a root-level fallback so a restart cannot
      // restore the stale binding.
      await this.state.markRevocationPending(this.callerId, profile).catch(() => {})
    })
    try {
      await this.executor.execute(
        ['auth', 'logout', `--profile=${profile}`, '--format=json'],
        new AbortController().signal,
        '',
        false,
      )
      const cleared: BindingRecord = { version: 1, revoked: true }
      this.record = cleared
      const persisted = await this.store.write(cleared).then(
        () => true,
        () => false,
      )
      if (persisted) await this.state.clearRevocationPending(this.callerId).catch(() => {})
    } catch {
      // Keep the pending marker in memory: status reports revocation_failed until cleanup succeeds.
    }
  }
  async disconnect(call: CallOptions = {}): Promise<{ disconnected: boolean }> {
    if (this.closed) throw new ConnectionServiceError('service_disposed')
    if (call.signal?.aborted) throw new ConnectionServiceError('execution_cancelled')
    this.authorizing = true
    try {
      return await this.state.withRefreshLock(this.callerId, async () => {
        const previous = this.backend
        this.backend = undefined
        const target = this.record.profile === this.profile ? this.profile : undefined
        await this.store.write({
          version: 1,
          revoked: true,
          ...(target ? { profile: target } : {}),
          ...(target ? { revocationPending: true } : {}),
        })
        await Promise.resolve(previous?.dispose())
        if (target) {
          try {
            await this.executor.execute(
              ['auth', 'logout', `--profile=${target}`, '--format=json'],
              call.signal ?? new AbortController().signal,
              '',
              false,
            )
          } catch {
            // A failed or unknown logout must stay a visible revocation block: keep the pending
            // marker in memory (not only on disk) so status never reports a fresh `unlinked`
            // state and a later authorization cannot silently overwrite the block.
            this.record = {
              version: 1,
              revoked: true,
              ...(target ? { profile: target, revocationPending: true } : {}),
            }
            this.authorizing = false
            this.abortInflight()
            this.auth()?.invalidate(this.callerId)
            throw new ConnectionServiceError('revocation_failed')
          }
        }
        await this.store.write({ version: 1, revoked: true })
        this.record = { version: 1, revoked: true }
        this.abortInflight()
        this.auth()?.invalidate(this.callerId)
        return { disconnected: true }
      })
    } finally {
      this.authorizing = false
    }
  }
  /** Admin/operator revocation: stop new work, abort in-flight calls and clear local authorization. */
  async revoke(): Promise<void> {
    this.closed = true
    this.abortInflight()
    this.auth()?.invalidate(this.callerId)
    const previous = this.backend
    this.backend = undefined
    // A never-authorized caller has no profile and no credentials: clear local state without a
    // meaningless remote logout that could leave a false revocation_failed marker.
    const profile = this.record.profile ?? (previous ? this.profile : undefined)
    const pending: BindingRecord = {
      version: 1,
      revoked: true,
      ...(profile ? { profile, revocationPending: true } : {}),
    }
    this.record = pending
    try {
      await this.store.write(pending)
    } catch {
      // A revocation that cannot be persisted is never reported as success: record a root-level
      // fallback marker so a restart cannot restore the stale binding, keep the in-memory block
      // and surface revocation_failed.
      await this.state.markRevocationPending(this.callerId, profile).catch(() => {})
      await Promise.resolve(previous?.dispose()).catch(() => {})
      throw new ConnectionServiceError('revocation_failed')
    }
    await Promise.resolve(previous?.dispose()).catch(() => {})
    if (!profile) {
      await this.state.clearRevocationPending(this.callerId).catch(() => {})
      return
    }
    try {
      await this.executor.execute(
        ['auth', 'logout', `--profile=${profile}`, '--format=json'],
        new AbortController().signal,
        '',
        false,
      )
      const cleared: BindingRecord = { version: 1, revoked: true }
      this.record = cleared
      const persisted = await this.store.write(cleared).then(
        () => true,
        () => false,
      )
      if (persisted) await this.state.clearRevocationPending(this.callerId).catch(() => {})
    } catch {
      // The durable pending marker and the in-memory block stay in place: status reports
      // revocation_failed and new calls are blocked. An explicit retry may clear it after a real
      // successful logout; no uncertain write is replayed automatically.
    }
  }
  private abortInflight(): void {
    for (const controller of this.inflight) controller.abort('execution_cancelled')
    this.inflight.clear()
  }
  async dispose(): Promise<void> {
    this.closed = true
    this.abortInflight()
    await Promise.resolve(this.backend?.dispose()).catch(() => {})
    this.backend = undefined
  }
}
export type { JsonValue, ExecutionLimits }

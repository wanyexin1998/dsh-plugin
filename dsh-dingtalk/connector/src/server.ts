import { createHash, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { ConnectionServiceError } from '../../enhancements/src/shared/models.js'
import type { ConnectionStatus, InvokeInput } from '../../enhancements/src/shared/models.js'
import { parseInvokeInput } from '../../enhancements/src/shared/validation.js'
import {
  CONNECTOR_PROTOCOL,
  CONNECTOR_ROUTES,
  assertNoIdentityFields,
  assertServerOperation,
  isJsonObject,
  parseCallerId,
  parseHostConfirmed,
  parseOptionalSessionId,
  parseProfile,
} from '../../enhancements/src/shared/connector.js'
import { ServerOAuth, START_PATH, CALLBACK_PATH } from './oauth.js'
import type { ConnectorConfig } from './config.js'
import { ConnectorState } from './state.js'
import type { BindingEntry } from './state.js'
import { UserSession } from './session.js'
import type { AuthorizationBridge } from './session.js'

export const CONNECTOR_VERSION = '0.1.0'
const MAX_BODY = 65536
const digest = (value: string) => createHash('sha256').update(value).digest()
const safeEqual = (left: string, right: string): boolean => timingSafeEqual(digest(left), digest(right))
function productionProfile(corpId: unknown, userId: unknown): { corpId: string; userId: string } {
  if (typeof corpId !== 'string' || typeof userId !== 'string') throw new ConnectionServiceError('invalid_request')
  const profile = parseProfile(`${corpId}:${userId}`)
  // Synthetic identities stay on the test adapter. Real users never go through test-identity.
  if (/^test-/i.test(profile.corpId) || /^test-/i.test(profile.userId))
    throw new ConnectionServiceError('invalid_request')
  return profile
}
const errorCode = (error: unknown): string =>
  error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable'
interface Route {
  path: string
  methods: readonly string[]
}
const BUSINESS: Route[] = Object.values(CONNECTOR_ROUTES)
  .filter((path) => path.startsWith('/v1/'))
  .map((path) => ({ path, methods: path === CONNECTOR_ROUTES.health ? ['GET'] : ['POST'] }))
const ADMIN: Route[] = Object.values(CONNECTOR_ROUTES)
  .filter((path) => path.startsWith('/admin/'))
  .map((path) => ({ path, methods: ['POST'] }))
function respond(res: ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}
const ok = (res: ServerResponse, value: unknown): void => respond(res, 200, { ok: true, value })
const fail = (res: ServerResponse, error: unknown): void => {
  const code = errorCode(error)
  const status =
    code === 'invalid_request' || code === 'invalid_auth_state'
      ? 400
      : code === 'command_unavailable' || code === 'identity_mismatch'
        ? 403
        : 500
  respond(res, status, { ok: false, error: { code } })
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') throw new ConnectionServiceError('invalid_request')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += part.length
    if (size > MAX_BODY) throw new ConnectionServiceError('invalid_request')
    chunks.push(part)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ConnectionServiceError('invalid_request')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectionServiceError('invalid_request')
  return value as Record<string, unknown>
}
const exact = (body: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(body).some((key) => !keys.includes(key))) throw new ConnectionServiceError('invalid_request')
}

/** Owns the private volume, per-caller sessions, transports and the server-side OAuth flow. */
export class ConnectorServer {
  readonly state: ConnectorState
  private sessions = new Map<string, UserSession>()
  private bindings = new Map<string, BindingEntry>()
  private oauth: ServerOAuth | undefined
  private auth: AuthorizationBridge | undefined
  private servers: Server[] = []
  private listeners = new Map<string, Server>()
  private adminServer: Server | undefined
  private loopbackServer: Server | undefined
  private loopbackAdmin: Server | undefined
  private tokens = new Map<string, string>()
  private adminToken = ''
  private closed = false
  private readonly testIdentity: boolean
  constructor(private readonly config: ConnectorConfig) {
    this.state = new ConnectorState(config.stateDirectory)
    this.testIdentity = config.testIdentity
  }
  async start(): Promise<void> {
    // Fail closed: a Connector that cannot durably persist revocation/binding state must not
    // start and then trust a stale `revoked:false` record after a restart.
    await this.state.assertWritable()
    await this.state.init()
    this.adminToken = await this.state.adminToken()
    if (this.config.dwsLock) process.env.DSH_DINGTALK_DWS_LOCK = this.config.dwsLock
    const file = await this.state.readBindings()
    for (const [callerId, entry] of Object.entries(file.bindings)) this.bindings.set(callerId, entry)
    if (this.config.oauth) {
      this.oauth = new ServerOAuth(
        this.config.oauth,
        {
          startDevice: (callerId, signal, transactionId) =>
            this.session(callerId).startDeviceLogin(signal, transactionId),
          rollback: (callerId, transactionId) => this.session(callerId).rollbackExchange(transactionId),
        },
        Date.now,
        this.config.testProvider ?? 'https://login.dingtalk.com/oauth2/auth',
      )
      await this.oauth.listen()
    }
    this.auth = {
      begin: (callerId, origin, returnPath, signal) => {
        if (!this.oauth) throw new ConnectionServiceError('oauth_not_configured')
        return this.oauth.begin(callerId, origin, returnPath, signal)
      },
      status: (callerId, transactionId) => {
        if (!this.oauth) throw new ConnectionServiceError('oauth_not_configured')
        return this.oauth.status(transactionId, callerId)
      },
      cancel: (callerId, transactionId) => {
        if (!this.oauth) throw new ConnectionServiceError('oauth_not_configured')
        return this.oauth.cancel(transactionId, callerId)
      },
      invalidate: (callerId) => this.oauth?.invalidate(callerId),
    }
    for (const callerId of [...this.bindings.keys()]) await this.addSession(callerId)
    if (this.config.transport === 'unix') await this.startUnix()
    else await this.startLoopback()
  }
  private async addSession(callerId: string): Promise<UserSession> {
    const existing = this.sessions.get(callerId)
    if (existing) return existing
    const binding = this.bindings.get(callerId)
    if (!binding) throw new ConnectionServiceError('invalid_request')
    const session = new UserSession(
      this.config,
      this.state,
      callerId,
      { corpId: binding.corpId, userId: binding.userId },
      () => this.auth,
    )
    await session.init()
    this.sessions.set(callerId, session)
    return session
  }
  private session(callerId: string): UserSession {
    const session = this.sessions.get(callerId)
    if (!session) throw new ConnectionServiceError('invalid_request')
    return session
  }
  /** Stable per-caller socket directory so a caller can mount the directory across Connector restarts. */
  private callerSocketDirectory(callerId: string): string {
    return join(this.state.socketsDirectory, callerId)
  }
  private callerSocketPath(callerId: string): string {
    return join(this.callerSocketDirectory(callerId), 'dsh.sock')
  }
  private async listenUnix(
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    directoryMode = 0o700,
  ): Promise<Server> {
    try {
      const info = await lstat(path)
      if (info.isSocket()) await unlink(path)
      else throw new Error('unexpected file in socket path')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(dirname(path), { recursive: true, mode: directoryMode })
    if (process.platform !== 'win32') await chmod(dirname(path), directoryMode)
    const server = createServer(handler)
    server.requestTimeout = 30000
    server.headersTimeout = 10000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    if (process.platform !== 'win32') await chmod(path, this.config.socketMode)
    this.servers.push(server)
    return server
  }
  private startCallerListener(callerId: string): Promise<Server> {
    const directoryMode = this.config.socketMode === 0o660 ? 0o750 : 0o700
    return this.listenUnix(
      this.callerSocketPath(callerId),
      (req, res) => {
        void this.business(callerId, req, res)
      },
      directoryMode,
    )
  }
  private async startUnix(): Promise<void> {
    await mkdir(this.state.socketsDirectory, { recursive: true, mode: 0o700 })
    for (const callerId of this.bindings.keys()) this.listeners.set(callerId, await this.startCallerListener(callerId))
    await mkdir(join(this.state.root, 'admin'), { recursive: true, mode: 0o700 })
    this.adminServer = await this.listenUnix(join(this.state.root, 'admin', 'admin.sock'), (req, res) => {
      void this.admin(req, res)
    })
  }
  private async startLoopback(): Promise<void> {
    const bind = (port: number, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> =>
      new Promise((resolve, reject) => {
        const server = createServer(handler)
        server.requestTimeout = 30000
        server.headersTimeout = 10000
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          this.servers.push(server)
          resolve(server)
        })
      })
    const tokens: [string, string][] = []
    for (const callerId of this.bindings.keys())
      tokens.push([await this.state.ensureCapabilityToken(callerId), callerId])
    this.tokens = new Map(tokens)
    this.loopbackServer = await bind(this.config.loopbackPort, (req, res) => {
      const caller = this.callerFromToken(req.headers.authorization)
      if (!caller) {
        respond(res, 403, { ok: false, error: { code: 'invalid_request' } })
        return
      }
      void this.business(caller, req, res)
    })
    this.loopbackAdmin = await bind(this.config.loopbackPort + 1, (req, res) => {
      void this.admin(req, res)
    })
  }
  private callerFromToken(header: string | undefined): string | undefined {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(header ?? '')
    if (!match) return undefined
    for (const [token, callerId] of this.tokens) if (safeEqual(token, match[1]!)) return callerId
    return undefined
  }
  private async business(callerId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Request-level cancellation: a client abort/closed response cancels the session work and the
    // DWS subprocess. A normally completed response has writableEnded=true, so close is not a cancel.
    const abortController = new AbortController()
    const abort = (): void => {
      if (!res.writableEnded) abortController.abort('execution_cancelled')
    }
    req.once('aborted', abort)
    res.once('close', abort)
    const signal = abortController.signal
    try {
      if (signal.aborted) throw new ConnectionServiceError('execution_cancelled')
      if (this.closed) throw new ConnectionServiceError('service_disposed')
      const url = new URL(req.url ?? '/', 'http://connector.invalid')
      if (url.search) throw new ConnectionServiceError('invalid_request')
      const route = BUSINESS.find((item) => item.path === url.pathname)
      if (!route) {
        respond(res, 404, { ok: false, error: { code: 'invalid_request' } })
        return
      }
      if (!route.methods.includes(req.method ?? '')) {
        respond(res, 405, { ok: false, error: { code: 'invalid_request' } })
        return
      }
      const session = this.session(callerId)
      if (route.path === CONNECTOR_ROUTES.health) {
        ok(res, {
          ok: true,
          protocol: CONNECTOR_PROTOCOL,
          version: CONNECTOR_VERSION,
          ...(this.config.oauth ? { callbackOrigin: this.config.oauth.publicOrigin } : {}),
        })
        return
      }
      const body = await readBody(req)
      if (signal.aborted) throw new ConnectionServiceError('execution_cancelled')
      if (route.path === CONNECTOR_ROUTES.status) {
        exact(body, [])
        const status = await session.status({ signal })
        // The caller's own identity on the private channel; the Host never projects it to the Client.
        const identity =
          status.state === 'connected' ||
          (status.state === 'unknown' &&
            ['business_verification_required', 'token_refresh_pending'].includes(status.reasonCode ?? ''))
            ? { corpId: session.binding.corpId, userId: session.binding.userId }
            : null
        ok(res, { status, identity })
        return
      }
      if (route.path === CONNECTOR_ROUTES.prepare) {
        exact(body, [])
        ok(res, await session.preparation(signal))
        return
      }
      if (route.path === CONNECTOR_ROUTES.identity) {
        exact(body, [])
        ok(res, await session.identity({ signal }))
        return
      }
      if (route.path === CONNECTOR_ROUTES.authorizationBegin) {
        exact(body, ['origin', 'returnPath'])
        ok(res, await session.beginAuthorization(body.origin, body.returnPath ?? '', signal))
        return
      }
      if (route.path === CONNECTOR_ROUTES.authorizationStatus) {
        exact(body, ['transactionId'])
        ok(res, { status: session.authorizationStatus(String(body.transactionId ?? '')) })
        return
      }
      if (route.path === CONNECTOR_ROUTES.authorizationCancel) {
        exact(body, ['transactionId'])
        ok(res, { status: session.authorizationCancel(String(body.transactionId ?? '')) })
        return
      }
      if (route.path === CONNECTOR_ROUTES.disconnect) {
        exact(body, [])
        ok(res, await session.disconnect({ signal }))
        return
      }
      if (route.path === CONNECTOR_ROUTES.invoke) {
        const keys = ['operationId', 'args']
        if (Object.hasOwn(body, 'sessionId')) keys.push('sessionId')
        if (Object.hasOwn(body, 'confirmed')) keys.push('confirmed')
        if (Object.hasOwn(body, 'expectedProfile')) {
          keys.push('expectedProfile')
          if (body.expectedProfile !== session.profile) throw new ConnectionServiceError('identity_mismatch')
        }
        exact(body, keys)
        assertNoIdentityFields(body)
        if (isJsonObject(body.args)) assertNoIdentityFields(body.args)
        const operationId = assertServerOperation(body.operationId)
        const input = parseInvokeInput({ operationId, args: body.args ?? {} }) as InvokeInput
        const sessionId = parseOptionalSessionId(body.sessionId)
        const confirmed = parseHostConfirmed(body.confirmed)
        ok(res, {
          result: await session.invoke(input, {
            signal,
            ...(sessionId ? { sessionId } : {}),
            // The private socket's Host already ran the approval UI. The model cannot set this flag.
            ...(confirmed ? { approve: async () => true } : {}),
          }),
        })
        return
      }
      respond(res, 404, { ok: false, error: { code: 'invalid_request' } })
    } catch (error) {
      fail(res, error)
    } finally {
      req.removeListener('aborted', abort)
      res.removeListener('close', abort)
    }
  }
  private authorizeAdmin(req: IncomingMessage): void {
    const header = req.headers['x-dsh-connector-admin-token']
    if (typeof header !== 'string' || !/^[a-f0-9]{64}$/.test(header) || !safeEqual(header, this.adminToken))
      throw new ConnectionServiceError('invalid_request')
  }
  private async admin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (this.closed) throw new ConnectionServiceError('service_disposed')
      this.authorizeAdmin(req)
      const url = new URL(req.url ?? '/', 'http://connector.invalid')
      if (url.search) throw new ConnectionServiceError('invalid_request')
      if (url.pathname === CONNECTOR_ROUTES.adminHealth) {
        ok(res, {
          ok: true,
          protocol: CONNECTOR_PROTOCOL,
          version: CONNECTOR_VERSION,
          oauth: !!this.oauth,
          callers: this.bindings.size,
        })
        return
      }
      const body = await readBody(req)
      if (url.pathname === CONNECTOR_ROUTES.adminCallers) {
        exact(body, [])
        const callers = []
        for (const callerId of this.bindings.keys()) {
          const status = await this.sessions
            .get(callerId)
            ?.status()
            .catch(() => undefined)
          callers.push({ callerId, state: status?.state ?? 'unknown', bound: this.bindings.has(callerId) })
        }
        ok(res, { callers })
        return
      }
      if (url.pathname === CONNECTOR_ROUTES.adminBindIdentity) {
        exact(body, ['callerId', 'corpId', 'userId'])
        const callerId = parseCallerId(body.callerId)
        const profile = productionProfile(body.corpId, body.userId)
        await this.bindCaller(callerId, profile)
        ok(res, { callerId, bound: true })
        return
      }
      if (url.pathname === CONNECTOR_ROUTES.adminBindTestIdentity) {
        exact(body, ['callerId', 'corpId', 'userId'])
        if (!this.testIdentity) throw new ConnectionServiceError('invalid_request')
        const callerId = parseCallerId(body.callerId)
        const profile = { corpId: String(body.corpId ?? ''), userId: String(body.userId ?? '') }
        parseProfile(`${profile.corpId}:${profile.userId}`)
        if (!/^test-[a-z0-9-]{2,40}$/.test(profile.corpId) || !/^test-[a-z0-9-]{2,40}$/.test(profile.userId))
          throw new ConnectionServiceError('invalid_request')
        await this.bindCaller(callerId, profile)
        ok(res, { callerId, bound: true })
        return
      }
      if (url.pathname === CONNECTOR_ROUTES.adminRemoveBinding) {
        exact(body, ['callerId'])
        const callerId = parseCallerId(body.callerId)
        const session = this.sessions.get(callerId)
        // Only remove the binding after revocation is durable; a failed revocation keeps the
        // caller bound and blocked instead of dropping the in-memory fail-closed block.
        if (session) await session.revoke()
        this.sessions.delete(callerId)
        this.bindings.delete(callerId)
        await this.closeListener(callerId)
        await this.state.removeBinding(callerId)
        await this.state.removeCapabilityToken(callerId)
        for (const [token, id] of this.tokens) if (id === callerId) this.tokens.delete(token)
        ok(res, { callerId, bound: false })
        return
      }
      if (url.pathname === CONNECTOR_ROUTES.adminRevoke) {
        exact(body, ['callerId'])
        const callerId = parseCallerId(body.callerId)
        const session = this.session(callerId)
        await session.revoke()
        this.sessions.delete(callerId)
        if (this.bindings.has(callerId)) await this.addSession(callerId)
        ok(res, { callerId, revoked: true })
        return
      }
      respond(res, 404, { ok: false, error: { code: 'invalid_request' } })
    } catch (error) {
      fail(res, error)
    }
  }
  private async bindCaller(callerId: string, profile: { corpId: string; userId: string }): Promise<void> {
    const existing = this.bindings.get(callerId)
    const same = !!existing && existing.corpId === profile.corpId && existing.userId === profile.userId
    if (same) {
      // Idempotent duplicate binding: keep the existing session and authorization state. Re-running
      // initialization must not revoke a live authorization or create a false revocation marker.
      if (!this.sessions.has(callerId)) await this.addSession(callerId)
      if (this.config.transport === 'unix') {
        if (!this.listeners.has(callerId)) this.listeners.set(callerId, await this.startCallerListener(callerId))
      } else this.tokens.set(await this.state.ensureCapabilityToken(callerId), callerId)
      return
    }
    const previous = this.sessions.get(callerId)
    if (previous) {
      // A binding change must not proceed when the old caller cannot be revoked durably.
      await previous.revoke()
      this.sessions.delete(callerId)
    }
    await this.state.setBinding(callerId, profile)
    this.bindings.set(callerId, { ...profile, createdAt: new Date().toISOString() })
    await this.addSession(callerId)
    if (this.config.transport === 'unix') {
      await this.closeListener(callerId)
      this.listeners.set(callerId, await this.startCallerListener(callerId))
    } else {
      this.tokens.set(await this.state.ensureCapabilityToken(callerId), callerId)
    }
  }
  private async closeListener(callerId: string): Promise<void> {
    const server = this.listeners.get(callerId)
    this.listeners.delete(callerId)
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const session of this.sessions.values()) await session.dispose().catch(() => {})
    this.sessions.clear()
    this.servers = []
    const servers = [this.adminServer, this.loopbackServer, this.loopbackAdmin, ...this.listeners.values()].filter(
      (value): value is Server => !!value,
    )
    for (const server of servers)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    await this.oauth?.dispose().catch(() => {})
    for (const socket of [
      join(this.state.root, 'admin', 'admin.sock'),
      ...[...this.bindings.keys()].map((callerId) => this.callerSocketPath(callerId)),
    ])
      await unlink(socket).catch(() => {})
  }
  get publicOrigin(): string | undefined {
    return this.config.oauth?.publicOrigin
  }
  get oauthStarted(): boolean {
    return !!this.oauth
  }
  get adminTokenValue(): string {
    return this.adminToken
  }
  get callerCount(): number {
    return this.bindings.size
  }
  get transport(): string {
    return this.config.transport
  }
}

export type { ConnectionStatus }
export { START_PATH, CALLBACK_PATH }

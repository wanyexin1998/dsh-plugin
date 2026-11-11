import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { ConnectionServiceError } from '../../enhancements/src/shared/models.js'
import type { ConnectionStatus } from '../../enhancements/src/shared/models.js'

const random = () => randomBytes(32).toString('base64url')
/** Official device-login window. The CLI waits about 15 minutes for the user to confirm. */
export const DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000
const PROMPT_TIMEOUT_MS = 12_000
export const START_PATH = '/dsh-dingtalk/start'
export const CALLBACK_PATH = '/dsh-dingtalk/callback'
interface Transaction {
  id: string
  callerId: string
  ownerOrigin: string
  returnPath: string
  ticket: string
  expires: number
  consumed: boolean
  manualCode?: string
  verificationUrl?: string
  result: ConnectionStatus
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
}
export interface ServerOAuthSettings {
  publicOrigin: string
  trustedOrigins: string[]
  listenPort: number
  tlsCert?: string
  tlsKey?: string
  /** Test-only barrier after login commits, used to inject a late cancellation. */
  testFinalizeGate?: string
}
export interface DeviceLoginStart {
  prompt: Promise<{ userCode: string; verificationUrl: string }>
  completion: Promise<ConnectionStatus>
}
export interface DeviceLoginOperations {
  /** Start `dws auth login --device` for one caller. The prompt resolves before the CLI exits. */
  startDevice(callerId: string, signal: AbortSignal, transactionId: string): DeviceLoginStart
  /** Roll back a login that committed after the user already cancelled the transaction. */
  rollback?(callerId: string, transactionId: string): Promise<void> | void
}
/** Server-side official CLI device login. The browser only opens the verification URL. */
export class ServerOAuth {
  private transactions = new Map<string, Transaction>()
  private server: Server | undefined
  private listening: Promise<void> | undefined
  private closed = false
  private readonly provider: URL
  constructor(
    private readonly settings: ServerOAuthSettings,
    private readonly operations: DeviceLoginOperations,
    private readonly clock = Date.now,
    provider = 'https://login.dingtalk.com/oauth2/auth',
  ) {
    this.provider = new URL(provider) // Host-internal test seam; env cannot select the provider.
  }
  get origin(): string {
    return this.settings.publicOrigin
  }
  private validateReturnPath(value: string): string {
    if (!value) return ''
    if (value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value))
      throw new ConnectionServiceError('invalid_request')
    const url = new URL(value, this.settings.publicOrigin)
    if (url.origin !== this.settings.publicOrigin || url.username || url.password)
      throw new ConnectionServiceError('invalid_request')
    if (
      [...url.searchParams.keys()].some((key) => /token|code|secret|state/i.test(key)) ||
      /[#?&](?:token|code|authCode|secret|state)=/i.test(url.hash)
    )
      throw new ConnectionServiceError('invalid_request')
    return url.pathname + url.search + url.hash
  }
  private assertOrigin(origin: unknown): string {
    if (typeof origin !== 'string' || !this.settings.trustedOrigins.includes(origin))
      throw new ConnectionServiceError('invalid_request')
    return origin
  }
  /** Accept the official DingTalk login host, or the explicit test provider. */
  private acceptedVerificationUrl(value: string): string | undefined {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return undefined
    }
    if (url.username || url.password || url.hash) return undefined
    // The test provider may be an HTTP loopback. Production stays on the official HTTPS host.
    if (url.origin === this.provider.origin) return url.href
    if (url.protocol !== 'https:') return undefined
    const host = url.hostname.toLowerCase()
    const official =
      host === 'dingtalk.com' ||
      host.endsWith('.dingtalk.com') ||
      host === 'dingtalk.cn' ||
      host.endsWith('.dingtalk.cn') ||
      host === 'dingtalk.io' ||
      host.endsWith('.dingtalk.io')
    if (!official) return undefined
    return url.href
  }
  async listen(): Promise<void> {
    if (this.closed) throw new ConnectionServiceError('service_disposed')
    if (this.server) {
      await this.listening
      return
    }
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(400)
        res.end('授权请求未完成，请返回原会话重试。')
      })
    }
    const server =
      this.settings.tlsCert && this.settings.tlsKey
        ? createHttpsServer(
            { cert: readFileSync(this.settings.tlsCert), key: readFileSync(this.settings.tlsKey) },
            handler,
          )
        : createHttpServer(handler)
    server.requestTimeout = 15000
    server.headersTimeout = 10000
    this.server = server
    try {
      this.listening = new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.settings.listenPort, '127.0.0.1', resolve)
      })
      await this.listening
    } catch {
      this.server = undefined
      server.close()
      throw new ConnectionServiceError('service_unavailable')
    }
  }
  async begin(
    callerId: string,
    origin: unknown,
    returnPath: unknown,
    signal?: AbortSignal,
  ): Promise<{ transactionId: string; authorizeUrl: string; expiresAt: string }> {
    if (this.closed) throw new ConnectionServiceError('service_disposed')
    this.assertOrigin(origin)
    if (typeof returnPath !== 'string') throw new ConnectionServiceError('invalid_request')
    this.validateReturnPath(returnPath)
    for (const [id, item] of this.transactions)
      if (item.expires + 120_000 < this.clock()) {
        clearTimeout(item.timer)
        item.controller.abort()
        this.transactions.delete(id)
      }
    if (this.transactions.size >= 64) throw new ConnectionServiceError('queue_full')
    const tx: Transaction = {
      id: random(),
      callerId,
      ownerOrigin: this.assertOrigin(origin),
      returnPath: this.validateReturnPath(returnPath),
      ticket: random(),
      expires: this.clock() + DEVICE_LOGIN_TTL_MS,
      consumed: false,
      result: { state: 'authorizing', reasonCode: 'authorization_pending' },
      controller: new AbortController(),
    }
    if (signal) {
      const forward = (): void => tx.controller.abort(signal.reason)
      if (signal.aborted) tx.controller.abort(signal.reason)
      else signal.addEventListener('abort', forward, { once: true })
    }
    this.transactions.set(tx.id, tx)
    tx.timer = setTimeout(() => {
      if (tx.result.state === 'authorizing') {
        tx.controller.abort()
        tx.consumed = true
        tx.result = { state: 'auth_timeout', reasonCode: 'auth_timeout' }
      }
    }, DEVICE_LOGIN_TTL_MS)
    tx.timer.unref()
    const started = this.operations.startDevice(callerId, tx.controller.signal, tx.id)
    let prompt: { userCode: string; verificationUrl: string }
    let promptTimer: ReturnType<typeof setTimeout> | undefined
    try {
      prompt = await new Promise<{ userCode: string; verificationUrl: string }>((resolve, reject) => {
        promptTimer = setTimeout(() => reject(new ConnectionServiceError('auth_timeout')), PROMPT_TIMEOUT_MS)
        promptTimer.unref()
        started.prompt.then(resolve, reject)
      })
      clearTimeout(promptTimer)
      const verificationUrl = this.acceptedVerificationUrl(prompt.verificationUrl)
      if (!verificationUrl || !prompt.userCode) throw new ConnectionServiceError('invalid_cli_output')
      if (!/^[A-Za-z0-9-]{4,64}$/.test(prompt.userCode)) throw new ConnectionServiceError('invalid_cli_output')
      if (![...new URL(verificationUrl).searchParams.values()].includes(prompt.userCode))
        tx.manualCode = prompt.userCode
      tx.verificationUrl = verificationUrl
    } catch (error) {
      clearTimeout(promptTimer)
      tx.controller.abort()
      clearTimeout(tx.timer)
      this.transactions.delete(tx.id)
      void started.completion.catch(() => {})
      throw error instanceof ConnectionServiceError ? error : new ConnectionServiceError('service_unavailable')
    }
    this.watch(tx, started.completion)
    return {
      transactionId: tx.id,
      authorizeUrl: `${this.settings.publicOrigin}${START_PATH}?t=${tx.ticket}`,
      expiresAt: new Date(tx.expires).toISOString(),
    }
  }
  private watch(tx: Transaction, completion: Promise<ConnectionStatus>): void {
    void completion
      .then(async (outcome) => {
        await this.finalizeBarrier()
        if (tx.controller.signal.aborted) {
          try {
            await this.operations.rollback?.(tx.callerId, tx.id)
          } catch {
            /* keep the cancelled result; the session keeps its fail-closed state */
          }
          if (tx.result.state === 'authorizing') tx.result = { state: 'user_cancelled', reasonCode: 'user_cancelled' }
          return
        }
        if (tx.result.state !== 'authorizing') return
        if (tx.expires <= this.clock()) {
          tx.result = { state: 'auth_timeout', reasonCode: 'auth_timeout' }
          return
        }
        tx.result = outcome
      })
      .catch((error: unknown) => {
        if (tx.result.state !== 'authorizing') return
        if (tx.controller.signal.aborted) {
          tx.result = { state: 'user_cancelled', reasonCode: 'user_cancelled' }
          return
        }
        const reasonCode = error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable'
        tx.result = {
          state:
            reasonCode === 'identity_mismatch'
              ? 'identity_mismatch'
              : reasonCode === 'token_exchange_failed'
                ? 'unlinked'
                : 'unknown',
          reasonCode,
        }
      })
      .finally(() => {
        clearTimeout(tx.timer)
      })
  }
  private owned(id: string, callerId: string): Transaction {
    const tx = this.transactions.get(id)
    if (!tx || tx.callerId !== callerId) throw new ConnectionServiceError('invalid_auth_state')
    if (tx.expires <= this.clock() && tx.result.state === 'authorizing') {
      clearTimeout(tx.timer)
      tx.controller.abort()
      tx.consumed = true
      tx.result = { state: 'auth_timeout', reasonCode: 'auth_timeout' }
    }
    return tx
  }
  status(id: string, callerId: string): ConnectionStatus {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(id))
      throw new ConnectionServiceError('invalid_request')
    return this.owned(id, callerId).result
  }
  cancel(id: string, callerId: string): ConnectionStatus {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(id))
      throw new ConnectionServiceError('invalid_request')
    const tx = this.owned(id, callerId)
    if (tx.result.state === 'authorizing') {
      clearTimeout(tx.timer)
      tx.consumed = true
      tx.controller.abort()
      tx.result = { state: 'user_cancelled', reasonCode: 'user_cancelled' }
    }
    return tx.result
  }
  invalidate(callerId: string): void {
    for (const tx of this.transactions.values())
      if (tx.callerId === callerId && tx.result.state === 'authorizing') this.cancel(tx.id, callerId)
  }
  private secure(req: IncomingMessage): boolean {
    if ((req.socket as { encrypted?: boolean }).encrypted === true) return true
    const forwarded = req.headers['x-forwarded-proto']
    return forwarded === 'https'
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const url = new URL(req.url ?? '/', this.settings.publicOrigin)
    if (
      req.method !== 'GET' ||
      req.headers.host !== new URL(this.settings.publicOrigin).host ||
      !this.secure(req) ||
      (req.url?.length ?? 0) > 16384
    ) {
      res.writeHead(403)
      res.end()
      return
    }
    if (url.pathname === CALLBACK_PATH) {
      res.writeHead(404)
      res.end('请从设置页重新连接。')
      return
    }
    if (url.pathname === START_PATH) {
      this.start(url, res)
      return
    }
    res.writeHead(404)
    res.end()
  }
  private start(url: URL, res: ServerResponse): void {
    if ([...url.searchParams.keys()].some((key) => key !== 't') || url.searchParams.getAll('t').length !== 1) {
      res.writeHead(400)
      res.end()
      return
    }
    const tx = [...this.transactions.values()].find((item) => item.ticket === url.searchParams.get('t'))
    if (!tx || tx.consumed || tx.expires <= this.clock() || tx.result.state !== 'authorizing' || !tx.verificationUrl) {
      res.writeHead(400)
      res.end('授权链接已失效。')
      return
    }
    if (tx.manualCode) {
      const href = tx.verificationUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      })
      res.end(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>钉钉授权</title><p>请在钉钉验证页输入授权码 <strong>${tx.manualCode}</strong></p><a rel="noreferrer" href="${href}">打开钉钉验证页</a></html>`,
      )
      return
    }
    res.writeHead(302, { Location: tx.verificationUrl })
    res.end()
  }
  /** Test-only barrier after a successful login, before the transaction result is published. */
  private async finalizeBarrier(): Promise<void> {
    const gate = this.settings.testFinalizeGate
    if (!gate) return
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      try {
        await stat(gate)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw new ConnectionServiceError('service_unavailable')
      }
      await new Promise((done) => setTimeout(done, 10))
    }
  }
  async dispose(): Promise<void> {
    this.closed = true
    for (const tx of this.transactions.values()) {
      clearTimeout(tx.timer)
      tx.controller.abort()
    }
    const server = this.server
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    }
    this.transactions.clear()
  }
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { ConnectionServiceError } from '../../enhancements/src/shared/models.js'
import type { ConnectionStatus } from '../../enhancements/src/shared/models.js'

const random = () => randomBytes(32).toString('base64url')
const digest = (value: string) => createHash('sha256').update(value).digest()
const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const TTL_MS = 120_000
export const START_PATH = '/dsh-dingtalk/start'
export const CALLBACK_PATH = '/dsh-dingtalk/callback'
interface Transaction {
  id: string
  callerId: string
  ownerOrigin: string
  returnPath: string
  state: string
  ticket: string
  proof: string
  nonce: string
  expires: number
  started: boolean
  consumed: boolean
  result: ConnectionStatus
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
}
export interface ServerOAuthSettings {
  publicOrigin: string
  trustedOrigins: string[]
  clientId: string
  scopes: string
  listenPort: number
  tlsCert?: string
  tlsKey?: string
  /** Test-only barrier after the exchange commit, used to inject a late cancellation. */
  testFinalizeGate?: string
}
export interface ExchangeOperations {
  exchange(callerId: string, code: string, signal: AbortSignal, transactionId?: string): Promise<ConnectionStatus>
  /** Roll back an exchange that committed after the user already cancelled the transaction. */
  rollback?(callerId: string, transactionId: string): Promise<void> | void
}
/** Server-side browser OAuth. Loopback stays in the plugin; this path is HTTPS-only and origin-bound. */
export class ServerOAuth {
  private transactions = new Map<string, Transaction>()
  private server: Server | undefined
  private listening: Promise<void> | undefined
  private closed = false
  private readonly callback: string
  private readonly provider: URL
  constructor(
    private readonly settings: ServerOAuthSettings,
    private readonly operations: ExchangeOperations,
    private readonly clock = Date.now,
    provider = 'https://login.dingtalk.com/oauth2/auth',
  ) {
    this.callback = new URL(CALLBACK_PATH, settings.publicOrigin).href
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
  begin(
    callerId: string,
    origin: unknown,
    returnPath: unknown,
  ): { transactionId: string; authorizeUrl: string; expiresAt: string } {
    if (this.closed) throw new ConnectionServiceError('service_disposed')
    const ownerOrigin = this.assertOrigin(origin)
    if (typeof returnPath !== 'string') throw new ConnectionServiceError('invalid_request')
    const safeReturn = this.validateReturnPath(returnPath)
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
      ownerOrigin,
      returnPath: safeReturn,
      state: random(),
      ticket: random(),
      proof: random(),
      nonce: random(),
      expires: this.clock() + TTL_MS,
      started: false,
      consumed: false,
      result: { state: 'authorizing', reasonCode: 'authorization_pending' },
      controller: new AbortController(),
    }
    this.transactions.set(tx.id, tx)
    tx.timer = setTimeout(() => {
      if (tx.result.state === 'authorizing') {
        tx.controller.abort()
        tx.consumed = true
        tx.result = { state: 'auth_timeout', reasonCode: 'auth_timeout' }
      }
    }, TTL_MS)
    tx.timer.unref()
    return {
      transactionId: tx.id,
      authorizeUrl: `${this.settings.publicOrigin}${START_PATH}?t=${tx.ticket}`,
      expiresAt: new Date(tx.expires).toISOString(),
    }
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
    if (url.pathname === START_PATH) {
      this.start(url, req, res)
      return
    }
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404)
      res.end()
      return
    }
    await this.callbackRequest(url, req, res)
  }
  private start(url: URL, req: IncomingMessage, res: ServerResponse): void {
    if ([...url.searchParams.keys()].some((key) => key !== 't') || url.searchParams.getAll('t').length !== 1) {
      res.writeHead(400)
      res.end()
      return
    }
    const tx = [...this.transactions.values()].find((item) => item.ticket === url.searchParams.get('t'))
    if (!tx || tx.started || tx.consumed || tx.expires <= this.clock()) {
      res.writeHead(400)
      res.end('授权链接已失效。')
      return
    }
    tx.started = true
    res.setHeader(
      'Set-Cookie',
      `dsh_dt_srv_${tx.id.slice(0, 16)}=${tx.proof}; HttpOnly; SameSite=Lax; Path=/dsh-dingtalk/; Secure; Max-Age=120`,
    )
    const target = new URL(this.provider)
    for (const [key, value] of Object.entries({
      client_id: this.settings.clientId,
      redirect_uri: this.callback,
      response_type: 'code',
      scope: this.settings.scopes,
      state: tx.state,
      nonce: tx.nonce,
      prompt: 'consent',
    }))
      target.searchParams.set(key, value)
    res.writeHead(302, { Location: target.href })
    res.end()
  }
  private async callbackRequest(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.origin && ![this.provider.origin, ...this.settings.trustedOrigins].includes(req.headers.origin)) {
      res.writeHead(403)
      res.end()
      return
    }
    if (
      [...url.searchParams.keys()].some(
        (key) => !['state', 'authCode', 'code', 'error', 'error_description'].includes(key),
      ) ||
      url.searchParams.getAll('state').length !== 1
    ) {
      res.writeHead(400)
      res.end()
      return
    }
    const tx = [...this.transactions.values()].find((item) => item.state === url.searchParams.get('state'))
    const proof =
      (req.headers.cookie ?? '')
        .split(';')
        .map((item) => item.trim())
        .find((item) => tx && item.startsWith(`dsh_dt_srv_${tx.id.slice(0, 16)}=`))
        ?.split('=')[1] ?? ''
    if (
      !tx ||
      !tx.started ||
      tx.consumed ||
      tx.expires <= this.clock() ||
      !timingSafeEqual(digest(proof), digest(tx.proof))
    ) {
      res.writeHead(400)
      res.end('授权校验失败，请返回原会话重试。')
      return
    }
    const authCodes = url.searchParams.getAll('authCode'),
      legacyCodes = url.searchParams.getAll('code')
    const codes = [...authCodes, ...legacyCodes]
    if (
      url.searchParams.getAll('error').length > 1 ||
      authCodes.length > 1 ||
      legacyCodes.length > 1 ||
      (url.searchParams.has('error')
        ? codes.length !== 0
        : !codes[0] ||
          codes[0].length > 8192 ||
          /[\u0000-\u001f\u007f]/.test(codes[0]) ||
          codes.some((code) => code !== codes[0]))
    ) {
      res.writeHead(400)
      res.end()
      return
    }
    tx.consumed = true // Atomic replay fence before any asynchronous exchange.
    res.setHeader(
      'Set-Cookie',
      `dsh_dt_srv_${tx.id.slice(0, 16)}=; HttpOnly; SameSite=Lax; Path=/dsh-dingtalk/; Secure; Max-Age=0`,
    )
    if (url.searchParams.has('error'))
      tx.result =
        url.searchParams.get('error') === 'access_denied'
          ? { state: 'user_cancelled', reasonCode: 'user_cancelled' }
          : { state: 'unknown', reasonCode: 'connection_unknown' }
    else {
      try {
        const outcome = await this.operations.exchange(tx.callerId, codes[0]!, tx.controller.signal, tx.id)
        await this.finalizeBarrier()
        if (tx.controller.signal.aborted) {
          // The exchange committed after the user cancelled: never leave a usable authorization.
          try {
            await this.operations.rollback?.(tx.callerId, tx.id)
          } catch {
            /* keep the cancelled result; the session keeps its fail-closed state */
          }
          if (tx.result.state === 'authorizing') tx.result = { state: 'user_cancelled', reasonCode: 'user_cancelled' }
        } else if (tx.expires > this.clock()) tx.result = outcome
        else if (tx.result.state === 'authorizing') tx.result = { state: 'auth_timeout', reasonCode: 'auth_timeout' }
      } catch (error) {
        if (!tx.controller.signal.aborted)
          tx.result = {
            state: 'unknown',
            reasonCode: error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable',
          }
        else if (tx.result.state === 'authorizing')
          tx.result = { state: 'user_cancelled', reasonCode: 'user_cancelled' }
      }
    }
    clearTimeout(tx.timer)
    this.completePage(res, tx)
  }
  /** Test-only barrier after a successful exchange, before the finalize decision. */
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
  private completePage(res: ServerResponse, tx: Transaction): void {
    const nonce = random()
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
    )
    const message = JSON.stringify({
      type: 'dsh-dingtalk:auth',
      transactionId: tx.id,
      result: tx.result.state,
    }).replaceAll('<', '\\u003c')
    const origin = JSON.stringify(tx.ownerOrigin)
    const connected = tx.result.state === 'connected'
    const back = tx.returnPath ? `${tx.ownerOrigin}${tx.returnPath}` : ''
    res.end(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>钉钉连接</title><style nonce="${nonce}">html{color-scheme:light dark}body{font:13px/1.8 system-ui,sans-serif;max-width:460px;margin:12vh auto;padding:32px;color:CanvasText;background:Canvas}h1{font-size:22px;font-weight:550;line-height:1.4;margin:24px 0 12px}p{color:color-mix(in srgb,CanvasText 65%,transparent)}a{display:inline-flex;align-items:center;min-height:33px;padding:6px 11px;border-radius:6px;background:#276be9;color:#fff;text-decoration:none;font-size:12px}</style><main><h1>${connected ? '连接好了，回到对话吧。' : '授权还没有完成。'}</h1><p>原来的会话和草稿都在。</p>${back ? `<a href="${escapeHtml(back)}" target="_self">返回原会话</a>` : ''}<small>这个页面可以关闭了</small></main><script nonce="${nonce}">history.replaceState(null,'','/dsh-dingtalk/complete');try{if(window.opener){window.opener.postMessage(${message},${origin});window.opener.focus();}}catch{}setTimeout(function(){try{window.close()}catch(e){}},${connected ? 600 : 3000});</script>`,
    )
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

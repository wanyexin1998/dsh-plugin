import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DingTalkIdentity } from '../identity.js'
import { messageIdentity } from '../identity.js'

export interface LoginOptions {
  publicOrigin: string
  clientId: string
  exchange(code: string, signal: AbortSignal): Promise<DingTalkIdentity>
}
interface Attempt {
  ticket: string
  state: string
  cookie: string
  expires: number
  started: boolean
  consumed: boolean
  controller: AbortController
  complete(identity: DingTalkIdentity): Promise<void>
  failed(reason: string): void
}
const random = () => randomBytes(32).toString('base64url')
const digest = (value: string) => createHash('sha256').update(value).digest()

/** Browser login proves identity to the gateway; DWS credentials never enter this flow. */
export class GatewayLogin {
  private attempts = new Map<string, Attempt>()
  private lastResult = 'idle'
  status() {
    return this.lastResult
  }
  readonly origin: string
  constructor(
    private options: LoginOptions,
    private now = Date.now,
  ) {
    const url = new URL(options.publicOrigin)
    if (
      url.origin !== options.publicOrigin ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error('invalid_login_origin')
    this.origin = url.origin
  }
  begin(complete: Attempt['complete'], failed: Attempt['failed']) {
    this.expire()
    if (this.attempts.size >= 64) throw new Error('login_busy')
    const attempt: Attempt = {
      ticket: random(),
      state: random(),
      cookie: random(),
      expires: this.now() + 300_000,
      started: false,
      consumed: false,
      controller: new AbortController(),
      complete,
      failed,
    }
    this.attempts.set(attempt.state, attempt)
    this.lastResult = 'pending'
    return {
      authorizeUrl: `${this.origin}/relay/login?t=${attempt.ticket}`,
      expires: attempt.expires,
      cancel: () => {
        attempt.controller.abort()
        this.attempts.delete(attempt.state)
      },
    }
  }
  expire() {
    for (const [id, a] of this.attempts)
      if (a.expires <= this.now()) {
        this.attempts.delete(id)
        a.controller.abort()
        a.failed('expired')
      }
  }
  close() {
    for (const a of this.attempts.values()) a.controller.abort()
    this.attempts.clear()
  }
  async handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'GET' || (req.url?.length ?? 0) > 16384) {
      res.writeHead(400)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', this.origin)
    if (url.pathname === '/relay/login') {
      const ticket = url.searchParams.get('t')
      const a = [...this.attempts.values()].find((item) => item.ticket === ticket)
      if (!a || a.started || a.consumed || a.expires <= this.now() || url.searchParams.size !== 1) {
        this.page(res, false)
        return
      }
      a.started = true
      res.setHeader(
        'Set-Cookie',
        `dsh_relay_${a.state.slice(0, 16)}=${a.cookie}; HttpOnly; SameSite=Lax; Path=/relay/callback; Max-Age=300${this.origin.startsWith('https:') ? '; Secure' : ''}`,
      )
      const target = new URL('https://login.dingtalk.com/oauth2/auth')
      for (const [k, v] of Object.entries({
        client_id: this.options.clientId,
        redirect_uri: `${this.origin}/relay/callback`,
        response_type: 'code',
        scope: 'openid corpid',
        prompt: 'consent',
        state: a.state,
      }))
        target.searchParams.set(k, v)
      res.writeHead(302, { Location: target.href })
      res.end()
      return
    }
    if (url.pathname !== '/relay/callback') {
      res.writeHead(404)
      res.end()
      return
    }
    const a = this.attempts.get(url.searchParams.get('state') ?? '')
    const cookie =
      (req.headers.cookie ?? '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith(`dsh_relay_${a?.state.slice(0, 16)}=`))
        ?.split('=')[1] ?? ''
    const codes = [...url.searchParams.getAll('code'), ...url.searchParams.getAll('authCode')]
    const validQuery =
      [...url.searchParams.keys()].every((k) =>
        ['state', 'code', 'authCode', 'error', 'error_description'].includes(k),
      ) && ['state', 'code', 'authCode', 'error'].every((k) => url.searchParams.getAll(k).length <= 1)
    if (
      !a ||
      !a.started ||
      a.consumed ||
      a.expires <= this.now() ||
      !validQuery ||
      !timingSafeEqual(digest(cookie), digest(a.cookie))
    ) {
      this.page(res, false)
      return
    }
    const denied = url.searchParams.has('error')
    const cancelled = url.searchParams.get('error') === 'access_denied'
    if (
      denied
        ? codes.length > 0
        : !codes[0] ||
          codes[0].length > 8192 ||
          codes.some((c) => c !== codes[0]) ||
          /[\u0000-\u001f\u007f]/.test(codes[0])
    ) {
      this.page(res, false)
      return
    }
    a.consumed = true
    res.setHeader(
      'Set-Cookie',
      `dsh_relay_${a.state.slice(0, 16)}=; HttpOnly; SameSite=Lax; Path=/relay/callback; Max-Age=0${this.origin.startsWith('https:') ? '; Secure' : ''}`,
    )
    try {
      if (denied) throw new Error('cancelled')
      const identity = await this.options.exchange(codes[0], a.controller.signal)
      if (a.controller.signal.aborted || a.expires <= this.now()) throw new Error('expired')
      await a.complete(identity)
      this.lastResult = 'connected'
      this.page(res, true)
    } catch (error) {
      const allowed = [
        'login_corp_mismatch',
        'login_user_missing',
        'login_member_missing',
        'login_exchange_failed',
        'login_user_failed',
        'login_membership_failed',
        'identity_mismatch',
        'device_not_ready',
      ]
      this.lastResult = cancelled
        ? 'cancelled'
        : error instanceof Error && allowed.includes(error.message)
          ? error.message
          : 'failed'
      a.failed(cancelled ? 'cancelled' : 'failed')
      this.page(res, false)
    } finally {
      this.attempts.delete(a.state)
      a.controller.abort()
    }
  }
  private page(res: ServerResponse, success: boolean) {
    const nonce = random()
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
    )
    res.writeHead(success ? 200 : 400)
    res.end(
      `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width"><title>连接机器人</title><style nonce="${nonce}">:root{color-scheme:light dark}body{margin:0;background:Canvas;color:CanvasText;font:14px/1.7 system-ui,sans-serif}main{max-width:420px;margin:20vh auto;padding:24px}h1{font-size:22px;font-weight:550}p{opacity:.65}button{border:1px solid #ddd;border-radius:7px;background:transparent;color:inherit;padding:8px 14px;cursor:pointer}</style><main><h1>${success ? '机器人已连接到这台 DSH。' : '连接尚未完成。'}</h1><p>${success ? '返回 DSH 即可使用。' : '原有设备的连接不会因此被替换。请回到 DSH 重试，并确认使用同一个企业账号。'}</p><button id="close">关闭页面</button></main><script nonce="${nonce}">history.replaceState(null,'','/relay/complete');document.getElementById('close').onclick=()=>window.close();</script></html>`,
    )
  }
}

export function dingTalkLoginExchange(
  config: { clientId: string; clientSecret: string; corpId: string },
  appToken: () => Promise<string>,
  request: typeof fetch = fetch,
) {
  return async (code: string, signal: AbortSignal): Promise<DingTalkIdentity> => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(25_000)])
    const json = async (url: string, init: RequestInit, step: string) => {
      const response = await request(url, { ...init, signal: bounded, redirect: 'error' })
      if (!response.ok) throw new Error(step)
      return response.json() as Promise<any>
    }
    const credential = await json(
      'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          code,
          grantType: 'authorization_code',
        }),
      },
      'login_exchange_failed',
    )
    if (credential.corpId !== config.corpId || typeof credential.accessToken !== 'string' || !credential.accessToken)
      throw new Error('login_corp_mismatch')
    const user = await json(
      'https://api.dingtalk.com/v1.0/contact/users/me',
      {
        method: 'GET',
        headers: { 'x-acs-dingtalk-access-token': credential.accessToken },
      },
      'login_user_failed',
    )
    if (typeof user.unionId !== 'string' || !user.unionId || user.unionId.length > 256)
      throw new Error('login_user_missing')
    const member = await json(
      `https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(await appToken())}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unionid: user.unionId }),
      },
      'login_membership_failed',
    )
    const identity = messageIdentity({ senderCorpId: credential.corpId, senderStaffId: member.result?.userid })
    if (member.errcode !== 0 || !identity) throw new Error('login_member_missing')
    return identity
  }
}

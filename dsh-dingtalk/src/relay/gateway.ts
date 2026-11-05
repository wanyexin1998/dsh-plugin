import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { messageIdentity, sameIdentity, type DingTalkIdentity } from '../identity.js'
import type { InboundMessage, InboundCardCallback } from '../stream.js'
import { Peer } from './protocol.js'
import { readState, saveState } from './state.js'
import { GatewayLogin, type LoginOptions } from './login.js'

interface Binding {
  identity: DingTalkIdentity
  device: string
  hash: string
}
interface Route {
  peer: Peer
  binding: Binding
}
interface RequestRoute extends Route {
  message: InboundMessage
  expires: number
}
const key = (identity: DingTalkIdentity) => JSON.stringify([identity.corpId, identity.userId])
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
export interface GatewayOptions {
  diagnostics?: () => unknown
  login?: LoginOptions
  stateFile: string
  host?: string
  port?: number
  allowedCorpId: string
  allowedGroups: readonly string[]
  /** Local personal onboarding can derive the user from robot OAuth itself. */
  allowUnclaimedPersonalLogin?: boolean
  notice(message: InboundMessage, text: string): Promise<unknown>
  operation(message: InboundMessage, method: string, data: any): Promise<unknown>
}

/** One gateway instance owns exactly one robot application. */
export class Gateway {
  private bindings: Binding[]
  private online = new Map<string, Route>()
  private attempts = new Map<Peer, { cancel(): void }>()
  private login?: GatewayLogin
  private activations = new Map<string, Promise<void>>()
  private requests = new Map<string, RequestRoute>()
  private cards = new Map<string, string>()
  private seen: Record<string, number>
  private server = createServer((req, res) => {
    if (!this.login) {
      res.writeHead(404)
      res.end()
      return
    }
    void this.login.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(400)
      res.end()
    })
  })
  private sockets = new WebSocketServer({ server: this.server, path: '/relay', maxPayload: 30 * 1024 * 1024 })
  private timer: NodeJS.Timeout
  private transportError = false
  constructor(private options: GatewayOptions) {
    // ws forwards the attached HTTP server's errors before start() can reject.
    // Handle both emitters: a recoverable bind failure must not terminate the Host.
    this.sockets.on('error', () => {
      this.transportError = true
    })
    this.login = options.login ? new GatewayLogin(options.login) : undefined
    this.bindings = readState(options.stateFile, [])
    this.seen = readState(`${options.stateFile}.seen`, {})
    this.sockets.on('connection', (socket, request) => {
      // Native clients only; Web UI uses authenticated local Host RPC.
      if (request.headers.origin || this.sockets.clients.size > 256) {
        socket.close(1008)
        return
      }
      let binding: Binding | undefined
      let initialized = false
      const deadline = setTimeout(() => {
        if (!initialized) socket.close(1008)
      }, 10_000)
      const peer = new Peer(socket, async (method, data) => {
        if (method === 'hello' && !initialized) {
          initialized = true
          if (typeof data?.token === 'string') {
            binding = this.bindings.find((item) => item.hash === hash(data.token))
            if (!binding) {
              socket.close(4001, 'device_replaced')
              throw new Error('invalid_device')
            }
            const old = this.online.get(key(binding.identity))
            old?.peer.socket.close(4001, 'device_replaced')
            this.online.set(key(binding.identity), { peer, binding })
            return { identity: binding.identity, device: binding.device }
          }
          const identity = messageIdentity({
            senderCorpId: data?.identity?.corpId,
            senderStaffId: data?.identity?.userId,
          })
          const unclaimed =
            options.allowUnclaimedPersonalLogin === true &&
            data?.identity === undefined &&
            ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')
          if ((!identity && !unclaimed) || (identity && identity.corpId !== options.allowedCorpId) || !this.login)
            throw new Error('login_unavailable')
          const attempt = this.login.begin(
            async (verified) => {
              if (verified.corpId !== options.allowedCorpId || (identity && !sameIdentity(identity, verified)))
                throw new Error('identity_mismatch')
              await this.activate(peer, verified, (value) => {
                binding = value
              })
              this.attempts.delete(peer)
            },
            (reason) => {
              this.attempts.delete(peer)
              void peer
                .call('auth-failed', { reason })
                .catch(() => undefined)
                .finally(() => socket.close(4002, 'login_failed'))
            },
          )
          this.attempts.set(peer, attempt)
          return { authorizeUrl: attempt.authorizeUrl, expires: attempt.expires }
        }
        if (!binding || this.online.get(key(binding.identity))?.peer !== peer) throw new Error('not_bound')
        if (method === 'unbind') {
          this.bindings = this.bindings.filter((item) => item !== binding)
          saveState(options.stateFile, this.bindings)
          this.online.delete(key(binding.identity))
          return true
        }
        if (method === 'diagnostics') return options.diagnostics?.() ?? {}
        if (method !== 'operation' || typeof data?.requestId !== 'string') throw new Error('invalid_method')
        const route = this.requests.get(data.requestId)
        if (!route || route.peer !== peer || route.expires < Date.now()) throw new Error('invalid_request')
        const allowed = [
          'text',
          'markdown',
          'card.create',
          'card.stream',
          'card.finish',
          'card.fail',
          'card.updateStatic',
          'interaction.create',
          'media',
          'emotion.add',
          'emotion.recall',
          'emotion.done',
        ]
        if (!allowed.includes(data.method)) throw new Error('invalid_operation')
        if (data.method === 'interaction.create') {
          const id = data.data?.outTrackId
          if (typeof id !== 'string' || id.length > 200 || this.cards.has(id)) throw new Error('invalid_card')
          this.cards.set(id, data.requestId)
        }
        return options.operation(route.message, data.method, data.data)
      })
      socket.on('close', () => {
        clearTimeout(deadline)
        if (binding && this.online.get(key(binding.identity))?.peer === peer) this.online.delete(key(binding.identity))
        this.attempts.get(peer)?.cancel()
        this.attempts.delete(peer)
      })
      let alive = true
      socket.on('pong', () => {
        alive = true
      })
      ;(socket as WebSocket & { heartbeat(): void }).heartbeat = () => {
        if (!alive) socket.terminate()
        else {
          alive = false
          socket.ping()
        }
      }
    })
    this.timer = setInterval(() => {
      for (const socket of this.sockets.clients) (socket as WebSocket & { heartbeat?(): void }).heartbeat?.()
      this.login?.expire()
      for (const [id, route] of this.requests) if (route.expires < Date.now()) this.requests.delete(id)
      for (const [id, request] of this.cards) if (!this.requests.has(request)) this.cards.delete(id)
    }, 30_000)
    this.timer.unref()
  }
  async start(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.options.port ?? 19878, this.options.host ?? '127.0.0.1', resolve)
    })
    return (this.server.address() as { port: number }).port
  }
  status() {
    return {
      transportError: this.transportError,
      boundUsers: this.bindings.length,
      onlineUsers: this.online.size,
      requests: this.requests.size,
      lastLogin: this.login?.status() ?? 'unconfigured',
    }
  }
  /** Live local proof; a stale device record or replaced/offline peer grants nothing. */
  authorizes(identity: DingTalkIdentity, device: string): boolean {
    const route = this.online.get(key(identity))
    if (
      !route ||
      route.peer.socket.readyState !== 1 ||
      route.binding.device !== device ||
      !this.bindings.includes(route.binding) ||
      !sameIdentity(route.binding.identity, identity)
    )
      return false
    try {
      const stored = readState<Binding[]>(this.options.stateFile, [])
      return (
        Array.isArray(stored) &&
        stored.some(
          (binding) =>
            binding.device === device &&
            binding.hash === route.binding.hash &&
            sameIdentity(binding.identity, identity),
        )
      )
    } catch {
      return false
    }
  }
  private async activate(peer: Peer, identity: DingTalkIdentity, assign: (binding: Binding) => void) {
    const id = key(identity)
    const previous = this.activations.get(id) ?? Promise.resolve()
    const work = previous.then(async () => {
      const ready = () => peer.socket.readyState === 1 && this.attempts.has(peer)
      if (!ready() || !(await peer.call('verify', identity))) throw new Error('identity_mismatch')
      const token = randomBytes(32).toString('base64url')
      const binding = { identity, device: randomUUID(), hash: hash(token) }
      if (!(await peer.call('prepare', { token, identity, device: binding.device })) || !ready())
        throw new Error('device_not_ready')
      // No awaits between durable commit and route replacement. Failed login/prepare preserves the old route.
      const next = [...this.bindings.filter((item) => !sameIdentity(item.identity, identity)), binding]
      saveState(this.options.stateFile, next)
      this.bindings = next
      const old = this.online.get(id)
      assign(binding)
      this.online.set(id, { peer, binding })
      if (old?.peer !== peer) old?.peer.socket.close(4001, 'device_replaced')
      void peer.call('paired', { identity, device: binding.device }).catch(() => undefined)
    })
    const tail = work.catch(() => undefined)
    this.activations.set(id, tail)
    try {
      await work
    } finally {
      if (this.activations.get(id) === tail) this.activations.delete(id)
    }
  }
  async receive(message: InboundMessage): Promise<void> {
    const identity = messageIdentity(message)
    if (!identity || identity.corpId !== this.options.allowedCorpId) {
      await this.options.notice(message, '无法确认当前企业身份。')
      return
    }
    if (/^\/bind(?:\s|$)/.test(message.text.trim())) {
      await this.options.notice(message, '请在 DSH 页面连接机器人，无需发送绑定指令。')
      return
    }
    if (message.conversationType === 'group' && !this.options.allowedGroups.includes(message.conversationId)) {
      await this.options.notice(message, '此群尚未开启机器人。')
      return
    }
    const route = this.online.get(key(identity))
    if (!route) {
      await this.options.notice(
        message,
        this.bindings.some((item) => sameIdentity(item.identity, identity))
          ? '你的 DSH 当前离线。'
          : '请先在本人 DSH 连接机器人。',
      )
      return
    }
    const id = createHash('sha256').update(message.msgId).digest('hex')
    if (this.seen[id] && this.seen[id] > Date.now()) return
    if (this.requests.size >= 4096) {
      await this.options.notice(message, '当前繁忙，请稍后重试。')
      return
    }
    for (const id of Object.keys(this.seen)) if (this.seen[id] < Date.now()) delete this.seen[id]
    this.seen[id] = Date.now() + 24 * 3600_000
    saveState(`${this.options.stateFile}.seen`, this.seen)
    this.requests.set(id, { ...route, message, expires: Date.now() + 3600_000 })
    try {
      const result = await route.peer.call('message', { requestId: id, message: { ...message, sessionWebhook: id } })
      if (result?.authRequired) await this.options.notice(message, '请在本人 DSH 重新连接钉钉。')
    } catch {
      await this.options.notice(message, '与本人 DSH 的连接中断，执行结果未确认，请先查询结果。')
    }
  }
  async card(callback: InboundCardCallback): Promise<unknown> {
    const request = this.cards.get(callback.outTrackId)
    const route = request && this.requests.get(request)
    if (
      !route ||
      route.expires < Date.now() ||
      callback.userId !== route.binding.identity.userId ||
      this.online.get(key(route.binding.identity))?.peer !== route.peer
    )
      return {}
    return route.peer.call('callback', callback).catch(() => ({}))
  }
  async close() {
    clearInterval(this.timer)
    this.login?.close()
    for (const socket of this.sockets.clients) socket.terminate()
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()))
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

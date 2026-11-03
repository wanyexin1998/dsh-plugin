import { dirname, join } from 'node:path'
import WebSocket from 'ws'
import { Peer } from './protocol.js'
import { readState, saveState } from './state.js'
import { sameIdentity, messageIdentity, type DingTalkIdentity } from '../identity.js'
import type { StreamOptions, InboundMessage } from '../stream.js'
import type { CardTarget } from '../aicard.js'

interface Saved {
  url?: string
  token?: string
  identity?: DingTalkIdentity
  replaced?: boolean
}
export class RelayClient {
  private saved: Saved
  private peer?: Peer
  private stopped = false
  private reconnect?: NodeJS.Timeout
  private routes = new Map<string, InboundMessage>()
  private messageRoutes = new Map<string, string>()
  private diagnosing = false
  private heartbeat?: NodeJS.Timeout
  private downloads = new Map<string, string>()
  private seen: Record<string, number>
  private callbacks?: Pick<StreamOptions, 'onMessage' | 'onCardCallback' | 'onStatus'>
  private view: { status: string; authorizeUrl?: string; expires?: number } = { status: 'disconnected' }
  constructor(
    private file: string,
    private identity: () => DingTalkIdentity | undefined,
  ) {
    this.saved = readState(file, {})
    if (this.saved.replaced) this.view = { status: 'replaced' }
    this.seen = readState(`${file}.seen`, {})
  }
  status() {
    return {
      ...this.view,
      ...(this.saved.token && !sameIdentity(this.saved.identity, this.identity()) ? { status: 'auth_required' } : {}),
      url: this.saved.url ?? '',
    }
  }
  async connect(url: string) {
    const parsed = new URL(url)
    if (
      (parsed.protocol !== 'wss:' &&
        !(parsed.protocol === 'ws:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname))) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/relay'
    )
      throw new Error('invalid_gateway_url')
    if (!this.identity()) throw new Error('auth_required')
    this.stop()
    this.peer = undefined
    this.stopped = false
    this.heartbeat = setInterval(() => this.publishRuntime(), 5000).unref()
    this.saved = { url }
    saveState(this.file, this.saved)
    await this.open()
    return this.status()
  }
  async disconnect() {
    this.stopped = true
    clearTimeout(this.reconnect)
    if (this.saved.token) await this.peer?.call('unbind', {}).catch(() => undefined)
    this.peer?.socket.close()
    this.peer = undefined
    this.saved = {}
    saveState(this.file, this.saved)
    this.view = { status: 'disconnected' }
  }
  async start(callbacks: Pick<StreamOptions, 'onMessage' | 'onCardCallback' | 'onStatus'>) {
    this.callbacks = callbacks
    clearInterval(this.heartbeat)
    this.heartbeat = setInterval(() => this.publishRuntime(), 5000).unref()
    this.publishRuntime()
    this.stopped = false
    if (this.saved.url && this.saved.token) await this.open().catch(() => undefined)
  }
  stop() {
    this.stopped = true
    clearInterval(this.heartbeat)
    this.publishRuntime()
    clearTimeout(this.reconnect)
    this.peer?.socket.close()
  }
  private async open() {
    if (!this.saved.url || this.stopped) return
    this.view = { status: 'connecting' }
    this.callbacks?.onStatus?.('connecting')
    const socket = new WebSocket(this.saved.url, { maxPayload: 30 * 1024 * 1024, handshakeTimeout: 10_000 })
    const peer = new Peer(socket, async (method, data) => {
      if (method === 'verify') return sameIdentity(this.identity(), data)
      if (method === 'prepare') {
        if (!sameIdentity(this.identity(), data?.identity) || typeof data.token !== 'string')
          throw new Error('identity_mismatch')
        this.saved = { url: this.saved.url, token: data.token, identity: data.identity }
        saveState(this.file, this.saved)
        return true
      }
      if (method === 'paired') {
        if (!sameIdentity(this.saved.identity, data?.identity)) throw new Error('identity_mismatch')
        this.view = { status: 'connected' }
        return true
      }
      if (method === 'auth-failed') {
        this.stopped = true
        this.saved = { url: this.saved.url }
        saveState(this.file, this.saved)
        this.view = { status: ['cancelled', 'expired'].includes(data?.reason) ? data.reason : 'failed' }
        return true
      }
      if (!sameIdentity(this.saved.identity, this.identity())) return { authRequired: true }
      if (method === 'message') {
        const msg = data?.message as InboundMessage
        if (!sameIdentity(messageIdentity(msg), this.saved.identity) || msg.sessionWebhook !== data.requestId)
          throw new Error('identity_mismatch')
        if (this.seen[data.requestId] > Date.now()) return { accepted: true }
        for (const id of Object.keys(this.seen)) if (this.seen[id] < Date.now()) delete this.seen[id]
        this.seen[data.requestId] = Date.now() + 24 * 3600_000
        saveState(`${this.file}.seen`, this.seen)
        this.messageRoutes.set(JSON.stringify([msg.conversationId, msg.msgId]), data.requestId)
        while (this.messageRoutes.size > 4096) this.messageRoutes.delete(this.messageRoutes.keys().next().value!)
        this.routes.set(
          this.targetKey(
            msg.conversationType === 'group'
              ? { type: 'group', openConversationId: msg.conversationId }
              : { type: 'user', userId: msg.senderStaffId },
          ),
          msg,
        )
        while (this.routes.size > 4096) this.routes.delete(this.routes.keys().next().value!)
        for (const part of msg.contentParts ?? [])
          if (part.type !== 'text') this.downloads.set(part.downloadCode, data.requestId)
        for (const code of msg.imageDownloadCodes ?? []) this.downloads.set(code, data.requestId)
        while (this.downloads.size > 4096) this.downloads.delete(this.downloads.keys().next().value!)
        if (!this.callbacks) throw new Error('not_ready')
        await this.callbacks.onMessage(msg)
        return { accepted: true }
      }
      if (method === 'callback') return this.callbacks?.onCardCallback?.(data) ?? {}
      throw new Error('invalid_method')
    })
    this.peer = peer
    socket.on('close', (code) => {
      if (this.peer !== peer || this.stopped) return
      if (code === 4001) {
        this.stopped = true
        clearTimeout(this.reconnect)
        this.saved = { url: this.saved.url, replaced: true }
        saveState(this.file, this.saved)
        this.view = { status: 'replaced' }
        return
      }
      if (code === 4002) {
        this.stopped = true
        this.saved = { url: this.saved.url }
        saveState(this.file, this.saved)
        this.view = { status: 'failed' }
        return
      }
      this.view = { status: 'offline' }
      this.callbacks?.onStatus?.('reconnecting')
      if (this.saved.token)
        this.reconnect = setTimeout(() => {
          void this.open().catch(() => undefined)
        }, 5000)
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const result = await peer.call(
      'hello',
      this.saved.token ? { token: this.saved.token } : { identity: this.identity() },
    )
    if (result.authorizeUrl) {
      const login = new URL(result.authorizeUrl),
        gateway = new URL(this.saved.url)
      gateway.protocol = gateway.protocol === 'wss:' ? 'https:' : 'http:'
      if (login.origin !== gateway.origin || login.pathname !== '/relay/login' || login.username || login.password) {
        socket.close()
        throw new Error('invalid_login_url')
      }
      this.view = { status: 'authorizing', authorizeUrl: login.href, expires: result.expires }
    } else if (!sameIdentity(result.identity, this.identity())) {
      this.view = { status: 'auth_required' }
    } else this.view = { status: 'connected' }
    this.callbacks?.onStatus?.('connected')
  }
  private publishRuntime() {
    if (this.diagnosing) return
    this.diagnosing = true
    const status = this.stopped ? 'stopped' : this.status().status
    const gateway = status === 'connected' ? this.peer?.call('diagnostics', {}, 3000).catch(() => undefined) : undefined
    void Promise.resolve(gateway)
      .then((value) => {
        try {
          saveState(join(dirname(this.file), 'relay-runtime.json'), {
            pid: process.pid,
            observedAt: Date.now(),
            status,
            gateway: value,
          })
        } catch {
          /* Diagnostics do not interrupt transport. */
        }
      })
      .finally(() => {
        this.diagnosing = false
      })
  }
  async emotion(action: 'add' | 'recall' | 'done', id: string, conversation: string) {
    const requestId = this.messageRoutes.get(JSON.stringify([conversation, id]))
    if (!requestId) return
    await this.operation(requestId, `emotion.${action}`, {})
  }
  private targetKey(target: CardTarget) {
    return JSON.stringify(target.type === 'group' ? ['group', target.openConversationId] : ['user', target.userId])
  }
  requestFor(target: CardTarget) {
    const msg = this.routes.get(this.targetKey(target))
    if (!msg) throw new Error('missing_route')
    return msg.sessionWebhook
  }
  async operation(requestId: string, method: string, data: unknown): Promise<any> {
    if (!this.peer) throw new Error('offline')
    return this.peer.call('operation', { requestId, method, data })
  }
  async media(code: string): Promise<{ data: Uint8Array; mediaType: string } | null> {
    const id = this.downloads.get(code)
    if (!id) return null
    const result = await this.operation(id, 'media', { code })
    return result ? { data: Buffer.from(result.data, 'base64'), mediaType: result.mediaType } : null
  }
  async createCard(target: CardTarget) {
    const requestId = this.requestFor(target)
    const id = await this.operation(requestId, 'card.create', {})
    if (!id) return null
    const invoke = async (method: string, content: string) => {
      await this.operation(requestId, method, { id, content })
    }
    return {
      outTrackId: id as string,
      stream: (s: string) => invoke('card.stream', s),
      finish: (s: string) => invoke('card.finish', s),
      fail: (s: string) => invoke('card.fail', s),
      updateStatic: (s: string) => invoke('card.updateStatic', s),
    }
  }
}

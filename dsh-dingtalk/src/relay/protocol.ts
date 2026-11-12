import { randomUUID } from 'node:crypto'
import { DeliveryOutcomeUnknown } from '../errors.js'
import type WebSocket from 'ws'

export interface Frame {
  id?: string
  reply?: string
  method?: string
  data?: any
  error?: string
}
/** Small, bounded request/reply channel; business requests are never replayed. */
export class Peer {
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  constructor(
    readonly socket: WebSocket,
    handler: (method: string, data: any) => Promise<any>,
  ) {
    socket.on('message', async (raw) => {
      let frame: Frame
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        socket.close(1008)
        return
      }
      if (!frame || typeof frame !== 'object') {
        socket.close(1008)
        return
      }
      if (frame.reply) {
        const pending = this.pending.get(frame.reply)
        if (!pending) return
        this.pending.delete(frame.reply)
        clearTimeout(pending.timer)
        if (frame.error === 'delivery_unknown') pending.reject(new DeliveryOutcomeUnknown(frame.error))
        else if (frame.error) pending.reject(new Error(frame.error))
        else pending.resolve(frame.data)
      } else if (typeof frame.id === 'string' && typeof frame.method === 'string') {
        try {
          this.send({ reply: frame.id, data: await handler(frame.method, frame.data) })
        } catch (error) {
          this.send({
            reply: frame.id,
            error: error instanceof DeliveryOutcomeUnknown ? 'delivery_unknown' : 'request_failed',
          })
        }
      }
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new DeliveryOutcomeUnknown('connection_lost'))
      }
      this.pending.clear()
    })
  }
  private send(frame: Frame) {
    if (this.socket.readyState === 1) this.socket.send(JSON.stringify(frame))
  }
  call(method: string, data: unknown, timeout = 30_000): Promise<any> {
    if (this.socket.readyState !== 1 || this.pending.size >= 128)
      return Promise.reject(new Error('connection_unavailable'))
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new DeliveryOutcomeUnknown('request_timeout'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, data })
    })
  }
}

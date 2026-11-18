/**
 * Outbound replies: POST the conversation's sessionWebhook with a markdown
 * body. Port of dingtalk-openclaw-connector `src/services/messaging/send.ts`
 * (fetch instead of axios; access token cached until near expiry).
 */
import { DeliveryOutcomeUnknown } from './errors.js'
import type { DingTalkAppCredentials } from './credentials.js'
import path from 'node:path'
import { FILE_TYPES, IMAGE_TYPES, MAX_MEDIA_BYTES } from './media.js'

export interface MediaTarget {
  conversationType: 'direct' | 'group'
  conversationId: string
  senderStaffId: string
}

export interface OutboundMedia {
  kind: 'file' | 'image'
  name: string
  data: Uint8Array
}

export interface MediaReceipt {
  status: 'accepted'
  processQueryKey: string
}

interface CachedToken {
  value: string
  expiresAt: number
}

function markdownSummary(text: string, fallback: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim()
  if (!firstLine) return fallback
  const summary = firstLine
    .replace(/^(?:#{1,6}|>|[-+])\s+/, '')
    .replace(/^(\*\*|__|~~|`|\*|_)(.+)\1$/, '$2')
    .trim()
  return summary || fallback
}

export class Outbound {
  #token: CachedToken | undefined
  #uploadToken: CachedToken | undefined

  constructor(
    private readonly credentials: DingTalkAppCredentials,
    private readonly log: (line: string) => void,
  ) {}

  /** Cached app access token, shared by emotion/card modules. */
  async token(): Promise<string> {
    return this.accessToken()
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.#token && Date.now() < this.#token.expiresAt - 60_000) return this.#token.value
    const resp = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.credentials.clientId, appSecret: this.credentials.clientSecret }),
      signal,
    })
    if (!resp.ok) throw new Error(`accessToken failed ${resp.status}: ${await resp.text()}`)
    const data: any = await resp.json()
    this.#token = {
      value: data.accessToken,
      expiresAt: Date.now() + (data.expireIn ?? 7200) * 1000,
    }
    return this.#token.value
  }

  // The legacy media uploader and v1 robot send endpoint use separate token APIs.
  private async mediaUploadToken(signal: AbortSignal): Promise<string> {
    if (this.#uploadToken && Date.now() < this.#uploadToken.expiresAt - 60_000) return this.#uploadToken.value
    const url = new URL('https://oapi.dingtalk.com/gettoken')
    url.searchParams.set('appkey', this.credentials.clientId)
    url.searchParams.set('appsecret', this.credentials.clientSecret)
    const response = await fetch(url, { signal, redirect: 'error' })
    if (!response.ok) throw new Error('upload_token_failed')
    const result = (await response.json()) as { errcode?: number; access_token?: string; expires_in?: number }
    if (result.errcode !== 0 || typeof result.access_token !== 'string' || !result.access_token)
      throw new Error('upload_token_failed')
    this.#uploadToken = { value: result.access_token, expiresAt: Date.now() + (result.expires_in ?? 7200) * 1000 }
    return this.#uploadToken.value
  }

  private async send(sessionWebhook: string, payload: unknown, chars: number): Promise<boolean> {
    try {
      const token = await this.accessToken()
      const resp = await fetch(sessionWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify(payload),
      })
      if (!resp.ok) {
        this.log(`reply failed ${resp.status}: ${await resp.text()}`)
        return false
      }
      const receipt = (await resp.json()) as { errcode?: number }
      if (receipt?.errcode !== 0) {
        this.log('reply rejected or receipt incomplete')
        return false
      }
      this.log(`reply sent (${chars} chars)`)
      return true
    } catch (err) {
      this.log(`reply error: ${err instanceof Error ? err.message : err}`)
      return false
    }
  }

  async sendMarkdown(sessionWebhook: string, title: string, text: string, mention?: string): Promise<boolean> {
    return this.send(
      sessionWebhook,
      {
        msgtype: 'markdown',
        ...(mention ? { at: { atUserIds: [mention], isAtAll: false } } : {}),
        markdown: { title: markdownSummary(text, title), text },
      },
      text.length,
    )
  }

  async sendText(sessionWebhook: string, content: string, mention?: string): Promise<boolean> {
    return this.send(
      sessionWebhook,
      { msgtype: 'text', text: { content }, ...(mention ? { at: { atUserIds: [mention], isAtAll: false } } : {}) },
      content.length,
    )
  }

  /** Push an approved reminder to the employee bound to this robot application. */
  async sendScheduledReminder(userId: string, content: string, signal: AbortSignal): Promise<MediaReceipt> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(12_000)])
    const token = await this.accessToken(bounded)
    bounded.throwIfAborted()
    let result: {
      processQueryKey?: string
      code?: string
      invalidStaffIdList?: string[]
      flowControlledStaffIdList?: string[]
    }
    try {
      const response = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify({
          robotCode: this.credentials.clientId,
          userIds: [userId],
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content }),
        }),
        signal: bounded,
        redirect: 'error',
      })
      if (!response.ok) throw new DeliveryOutcomeUnknown('scheduled_send_unconfirmed')
      result = await response.json()
    } catch {
      throw new DeliveryOutcomeUnknown('scheduled_send_unconfirmed')
    }
    if (result?.invalidStaffIdList?.length || result?.flowControlledStaffIdList?.length)
      throw new Error('scheduled_recipient_rejected')
    if (!result || result.code || typeof result.processQueryKey !== 'string' || !result.processQueryKey)
      throw new DeliveryOutcomeUnknown('scheduled_receipt_missing')
    return { status: 'accepted', processQueryKey: result.processQueryKey }
  }

  /** 应用机器人原会话回发；API 接受不等于客户端送达，不自动重试未知结果。 */
  async sendMedia(target: MediaTarget, media: OutboundMedia, signal?: AbortSignal): Promise<MediaReceipt> {
    const extension = path.extname(media.name).slice(1).toLowerCase()
    if (!(media.kind === 'file' ? FILE_TYPES : IMAGE_TYPES).has(extension)) throw new Error('unsupported_file_type')
    if (!media.data.length || media.data.length > MAX_MEDIA_BYTES) throw new Error('media_too_large_or_empty')
    if (target.conversationType === 'direct' ? !target.senderStaffId : !target.conversationId)
      throw new Error('media_target_unavailable')
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)
    bounded.throwIfAborted()
    let token: string
    let mediaId: string
    try {
      token = await this.accessToken(bounded)
      const uploadToken = await this.mediaUploadToken(bounded)
      bounded.throwIfAborted()
      const form = new FormData()
      form.set('media', new Blob([new Uint8Array(media.data)], { type: 'application/octet-stream' }), media.name)
      const url = new URL('https://oapi.dingtalk.com/media/upload')
      url.searchParams.set('access_token', uploadToken)
      url.searchParams.set('type', media.kind)
      const response = await fetch(url, { method: 'POST', body: form, signal: bounded, redirect: 'error' })
      if (!response.ok) throw new Error('upload_failed')
      const result = (await response.json()) as { errcode?: number; media_id?: string }
      if (result.errcode !== 0 || typeof result.media_id !== 'string' || !result.media_id)
        throw new Error('upload_failed')
      mediaId = result.media_id
    } catch {
      this.log('media upload failed')
      throw new Error('media_upload_failed')
    }
    bounded.throwIfAborted()
    const direct = target.conversationType === 'direct'
    let result: {
      processQueryKey?: string
      code?: string
      errcode?: number
      invalidStaffIdList?: string[]
      flowControlledStaffIdList?: string[]
    }
    try {
      const response = await fetch(
        `https://api.dingtalk.com/v1.0/robot/${direct ? 'oToMessages/batchSend' : 'groupMessages/send'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
          body: JSON.stringify({
            robotCode: this.credentials.clientId,
            ...(direct ? { userIds: [target.senderStaffId] } : { openConversationId: target.conversationId }),
            msgKey: media.kind === 'file' ? 'sampleFile' : 'sampleImageMsg',
            msgParam: JSON.stringify(
              media.kind === 'file' ? { mediaId, fileName: media.name, fileType: extension } : { photoURL: mediaId },
            ),
          }),
          signal: bounded,
        },
      )
      if (!response.ok) throw new Error('send_failed')
      result = await response.json()
      if (
        !result ||
        typeof result.processQueryKey !== 'string' ||
        !result.processQueryKey ||
        result.code ||
        result.errcode
      )
        throw new Error('send_failed')
    } catch {
      this.log('media send unconfirmed; no automatic retry')
      throw new DeliveryOutcomeUnknown('media_send_unconfirmed')
    }
    if (direct && (result.invalidStaffIdList?.length || result.flowControlledStaffIdList?.length)) {
      this.log('media send rejected for recipient')
      throw new Error('media_recipient_rejected')
    }
    this.log(`media send accepted (${media.kind}, ${media.data.length} bytes)`)
    return { status: 'accepted', processQueryKey: result.processQueryKey }
  }
}

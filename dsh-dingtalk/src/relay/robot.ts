import { join } from 'node:path'
import { dingTalkLoginExchange } from './login.js'
import { Gateway } from './gateway.js'
import { startStream } from '../stream.js'
import { Outbound } from '../outbound.js'
import { AICard, CardCapability } from '../aicard.js'
import { Emotion } from '../emotion.js'
import { InteractionCards } from '../interaction-card.js'
import { cardTarget } from '../targets.js'
import { downloadFileByCode, MAX_MEDIA_BYTES } from '../media.js'

export interface RobotGatewayConfig {
  clientId: string
  clientSecret: string
  corpId: string
  stateDirectory: string
  publicOrigin: string
  host?: string
  port?: number
  allowedGroups?: string[]
  interactionCardTemplateId?: string
}
export async function startRobotGateway(config: RobotGatewayConfig) {
  if (!config.clientId || !config.clientSecret || !config.corpId || !config.stateDirectory || !config.publicOrigin)
    throw new Error('invalid_gateway_config')
  const log = (_line: string) => undefined // SDK payloads and credentials never enter gateway logs.
  const outbound = new Outbound(config, log)
  const capability = new CardCapability()
  const cards = new Map<string, { card: AICard; messageId: string; expires: number }>()
  const emotion = new Emotion(() => outbound.token(), config.clientId, log)
  const interactions = config.interactionCardTemplateId
    ? new InteractionCards(() => outbound.token(), config.clientId, config.interactionCardTemplateId, log)
    : undefined
  const gateway = new Gateway({
    login: {
      publicOrigin: config.publicOrigin,
      clientId: config.clientId,
      exchange: dingTalkLoginExchange(config, () => outbound.token()),
    },
    stateFile: join(config.stateDirectory, 'bindings.json'),
    host: config.host,
    port: config.port,
    allowedCorpId: config.corpId,
    allowedGroups: config.allowedGroups ?? [],
    notice: (msg, text) => outbound.sendText(msg.sessionWebhook, text),
    operation: async (msg, method, data) => {
      if (method === 'text') return outbound.sendText(msg.sessionWebhook, String(data.text).slice(0, 30000))
      if (method === 'markdown')
        return outbound.sendMarkdown(
          msg.sessionWebhook,
          String(data.title).slice(0, 100),
          String(data.text).slice(0, 30000),
        )
      if (method === 'emotion.add') {
        emotion.add(msg.msgId, msg.conversationId)
        return true
      }
      if (method === 'emotion.recall') {
        await emotion.recall(msg.msgId, msg.conversationId)
        return true
      }
      if (method === 'interaction.create') return interactions?.create({ ...data, target: cardTarget(msg) }) ?? false
      if (method === 'media') {
        const codes = [
          ...(msg.imageDownloadCodes ?? []),
          ...(msg.contentParts ?? []).flatMap((p) => (p.type === 'text' ? [] : [p.downloadCode])),
        ]
        if (!codes.includes(data.code)) throw new Error('invalid_media')
        const bytes = await downloadFileByCode(await outbound.token(), config.clientId, data.code, log)
        if (!bytes || bytes.length > MAX_MEDIA_BYTES) return null
        const mediaType =
          bytes[0] === 0x89
            ? 'image/png'
            : bytes[0] === 0x47
              ? 'image/gif'
              : bytes[8] === 0x57
                ? 'image/webp'
                : 'image/jpeg'
        return { data: Buffer.from(bytes).toString('base64'), mediaType }
      }
      for (const [id, card] of cards) if (card.expires < Date.now()) cards.delete(id)
      if (method === 'card.create') {
        if (cards.size >= 4096) return null
        const card = await AICard.create({
          token: () => outbound.token(),
          robotCode: config.clientId,
          target: cardTarget(msg),
          capability,
          log,
        })
        if (card) cards.set(card.outTrackId, { card, messageId: msg.msgId, expires: Date.now() + 3600_000 })
        return card?.outTrackId ?? null
      }
      const item = cards.get(data.id)
      if (!item || item.messageId !== msg.msgId) throw new Error('invalid_card')
      const content = String(data.content).slice(0, 30000)
      if (method === 'card.stream') await item.card.stream(content)
      else if (method === 'card.finish') await item.card.finish(content)
      else if (method === 'card.fail') await item.card.fail(content)
      else if (method === 'card.updateStatic') await item.card.updateStatic(content)
      else throw new Error('invalid_method')
      return true
    },
  })
  const port = await gateway.start()
  let stop: (() => void) | undefined
  let streamStatus = 'connecting'
  try {
    stop = await startStream({
      ...config,
      seenFile: join(config.stateDirectory, 'stream-seen.json'),
      log,
      onMessage: async (msg) => {
        try {
          await gateway.receive(msg)
        } catch {
          await outbound.sendText(msg.sessionWebhook, '本次连接未完成，请稍后重试。')
        }
      },
      onCardCallback: (callback) => gateway.card(callback),
      onStatus: (status) => {
        streamStatus = status
      },
    })
  } catch (error) {
    await gateway.close()
    throw error
  }
  return {
    port,
    status: () => ({ stream: streamStatus, ...gateway.status() }),
    close: async () => {
      stop?.()
      await gateway.close()
    },
  }
}

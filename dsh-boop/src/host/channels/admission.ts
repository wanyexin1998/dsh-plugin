/**
 * IM admission for DingTalk / Feishu (E06-01, 01§12, 03§15).
 *
 * In-memory policy only: no sockets, no filesystem, secrets not retained.
 * Absent credentials keep both channels closed. This file records no gate
 * result. Remote text never grants an approval. Binding is only bindOwner().
 */

export type ChannelId = 'dingtalk' | 'feishu'
export type ChannelAvailability = 'closed' | 'configured'
export type RejectReason =
  | 'CREDENTIALS_ABSENT'
  | 'UNKNOWN_ACTOR'
  | 'GROUP_REJECTED'
  | 'REMOTE_APPROVAL_BLOCKED'
export type RiskLevel = 'low' | 'high'
export type ConversationKind = 'direct' | 'group'

export interface ChannelCredential {
  appId: string
  appSecret: string
}
export interface ChannelCredentials {
  dingtalk?: ChannelCredential | null
  feishu?: ChannelCredential | null
}

export interface InboundEnvelope {
  channel: ChannelId
  appId: string
  tenantId: string
  actorId: string
  conversationId: string
  conversationKind: ConversationKind
  eventId: string
  messageId: string
  timestamp: string
  text: string
  risk?: RiskLevel
  verifiedBindingId?: string
}

export interface AdmitResult {
  rejected: boolean
  reason?: RejectReason
  admitted?: boolean
  noted?: boolean
  duplicate?: boolean
  taskId?: string
  noteId?: string
}

export interface AdmittedTask {
  id: string
  channel: ChannelId
  appId: string
  tenantId: string
  actorId: string
  conversationId: string
  eventId: string
  messageId: string
  text: string
  risk: 'low'
}

export interface LowRiskNote {
  id: string
  channel: ChannelId
  tenantId: string
  actorId: string
  conversationId: string
  eventId: string
  text: string
  risk: 'low'
}

export interface OwnerBinding { channel: ChannelId; tenantId: string; actorId: string }
export interface ReplyRouteRequest { taskId: string; text: string }
export interface ReplyDestination { channel: ChannelId; conversationId: string }
export interface RoutedReply {
  channel: ChannelId
  conversationId: string
  text: string
  destinations: readonly ReplyDestination[]
}

export interface AdmissionRuntime {
  readonly networkAttempts: 0
  readonly tasks: readonly AdmittedTask[]
  readonly admissions: readonly AdmittedTask[]
  readonly notes: readonly LowRiskNote[]
  readonly approvals: readonly []
  status(): { dingtalk: ChannelAvailability; feishu: ChannelAvailability }
  bindOwner(binding: OwnerBinding): OwnerBinding
  admit(message: InboundEnvelope): AdmitResult
  routeReply(request: ReplyRouteRequest): RoutedReply
}

const CHANNELS: readonly ChannelId[] = ['dingtalk', 'feishu']
const EMPTY_APPROVALS = Object.freeze([]) as readonly []
const APPROVAL_TEXT = [/同意部署/, /\bapprove\b/i, /\byes\s+deploy\b/i]

const reject = (reason: RejectReason): AdmitResult => ({ rejected: true, reason })

function configuredAppId(credential: ChannelCredential | null | undefined): string | null {
  if (!credential || typeof credential.appId !== 'string' || typeof credential.appSecret !== 'string') return null
  const appId = credential.appId.trim()
  return appId && credential.appSecret.trim() ? appId : null
}

function isApprovalText(text: string): boolean {
  return APPROVAL_TEXT.some((pattern) => pattern.test(text))
}

function createRuntime(credentials: ChannelCredentials): AdmissionRuntime {
  const apps: Record<ChannelId, string | null> = {
    dingtalk: configuredAppId(credentials.dingtalk),
    feishu: configuredAppId(credentials.feishu),
  }
  const owners = new Map<string, string>()
  const tasks: AdmittedTask[] = []
  const notes: LowRiskNote[] = []
  const recorded = new Map<string, { kind: 'task' | 'note'; id: string }>()
  const spoken = new Map<string, string[]>()
  let seq = 0

  const remember = (channel: ChannelId, conversationId: string, text: string) => {
    const key = `${channel}\0${conversationId}`
    const list = spoken.get(key)
    if (list) list.push(text)
    else spoken.set(key, [text])
  }

  return {
    get networkAttempts() { return 0 as const },
    get tasks() { return tasks.slice() },
    get admissions() { return tasks.slice() },
    get notes() { return notes.slice() },
    get approvals() { return EMPTY_APPROVALS },
    status() {
      return {
        dingtalk: apps.dingtalk ? 'configured' : 'closed',
        feishu: apps.feishu ? 'configured' : 'closed',
      }
    },
    bindOwner(binding) {
      const tenantId = binding.tenantId.trim()
      const actorId = binding.actorId.trim()
      if (!CHANNELS.includes(binding.channel) || !tenantId || !actorId) {
        throw new TypeError('bindOwner requires channel, tenantId, and actorId')
      }
      owners.set(`${binding.channel}\0${tenantId}`, actorId)
      return { channel: binding.channel, tenantId, actorId }
    },
    admit(message) {
      if (!CHANNELS.includes(message.channel)) return reject('CREDENTIALS_ABSENT')
      const channel = message.channel
      if (!apps[channel] || message.appId !== apps[channel]) return reject('CREDENTIALS_ABSENT')
      if (message.conversationKind !== 'direct') return reject('GROUP_REJECTED')
      const tenantId = message.tenantId.trim()
      const actorId = message.actorId.trim()
      if (!tenantId || !actorId || owners.get(`${channel}\0${tenantId}`) !== actorId) {
        return reject('UNKNOWN_ACTOR')
      }

      const key = `${channel}\0${message.appId}\0${tenantId}\0${message.eventId}`
      const prior = recorded.get(key)
      if (prior?.kind === 'task') return { rejected: false, admitted: true, duplicate: true, taskId: prior.id }
      if (prior?.kind === 'note') return { rejected: false, noted: true, duplicate: true, noteId: prior.id }

      const approval = isApprovalText(message.text)
      if (message.risk === 'high' || (approval && message.risk !== 'low')) return reject('REMOTE_APPROVAL_BLOCKED')

      if (approval) {
        const note: LowRiskNote = {
          id: `note-${++seq}`,
          channel,
          tenantId,
          actorId,
          conversationId: message.conversationId,
          eventId: message.eventId,
          text: message.text,
          risk: 'low',
        }
        notes.push(note)
        recorded.set(key, { kind: 'note', id: note.id })
        remember(channel, message.conversationId, message.text)
        return { rejected: false, noted: true, duplicate: false, noteId: note.id }
      }

      const task: AdmittedTask = {
        id: `task-${++seq}`,
        channel,
        appId: message.appId,
        tenantId,
        actorId,
        conversationId: message.conversationId,
        eventId: message.eventId,
        messageId: message.messageId,
        text: message.text,
        risk: 'low',
      }
      tasks.push(task)
      recorded.set(key, { kind: 'task', id: task.id })
      remember(channel, message.conversationId, message.text)
      return { rejected: false, admitted: true, duplicate: false, taskId: task.id }
    },
    routeReply(request) {
      const task = tasks.find((item) => item.id === request.taskId)
      if (!task) throw new Error('UNKNOWN_TASK')
      const originKey = `${task.channel}\0${task.conversationId}`
      const originBlob = (spoken.get(originKey) ?? []).join('\n')
      const phrases: string[] = []
      for (const [key, list] of spoken) {
        if (key === originKey) continue
        for (const phrase of list) {
          if (phrase.length > 0 && !originBlob.includes(phrase)) phrases.push(phrase)
        }
      }
      phrases.sort((left, right) => right.length - left.length)
      let text = request.text
      for (const phrase of phrases) text = text.split(phrase).join('')
      const destination = { channel: task.channel, conversationId: task.conversationId }
      return {
        channel: destination.channel,
        conversationId: destination.conversationId,
        text: text.replace(/[ \t]{2,}/g, ' ').trim(),
        destinations: [destination],
      }
    },
  }
}

export function closedChannelRuntime(): AdmissionRuntime {
  return createRuntime({})
}

export function openChannelRuntime(credentials: ChannelCredentials): AdmissionRuntime {
  return createRuntime(credentials)
}

export const ChannelRuntime = {
  closed: closedChannelRuntime,
  open: openChannelRuntime,
}

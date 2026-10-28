/**
 * Read official session facts.
 *
 * SessionHeader uses `parentSession`, `origin` and `agentPreset`.
 * `listEvents` records are an index: `surface` is `current | shadowed | log-only`,
 * not the message body. Text comes from `user/message` and `assistant/message` data.
 * A session being loaded (`live`) is not the same thing as the agent running.
 */

import type { ContextEvent, TargetObservation } from '../delegation/service.ts'

export interface OfficialHeader {
  id?: string
  cwd?: string
  parentSession?: string
  origin?: string
  agentPreset?: string
  version?: number
  createdAt?: number
}

export interface OfficialEvent {
  type?: string
  seq?: number
  data?: {
    id?: string
    role?: string
    source?: { kind?: string }
    content?: Array<{ type?: string; text?: string }>
    message?: { id?: string; content?: Array<{ type?: string; text?: string }>; source?: { kind?: string } }
    turn?: number
    reason?: { kind?: string }
  }
}

export interface InterpretInput {
  header: OfficialHeader
  events: OfficialEvent[]
  agentStatus: 'idle' | 'running' | 'unknown'
  workspaceId: string | null
  title: string
  homeSessionId: string | null
  revision?: string | number | null
  pendingMessage?: boolean
}

const TERMINAL = new Set(['completed', 'aborted', 'error', 'max-tokens', 'interrupted', 'forked'])

function blocks(content: Array<{ type?: string; text?: string }> | undefined): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim()
}

function eventText(event: OfficialEvent): string {
  if (event.type === 'user/message') return blocks(event.data?.content)
  if (event.type === 'assistant/message') return blocks(event.data?.message?.content)
  return ''
}

function ordered(events: OfficialEvent[]): OfficialEvent[] {
  return events
    .filter((event) => typeof event?.seq === 'number' && Number.isFinite(event.seq))
    .slice()
    .sort((left, right) => Number(left.seq) - Number(right.seq))
}

export function interpretTarget(input: InterpretInput): TargetObservation {
  const header = input.header ?? {}
  const events = ordered(input.events ?? [])
  const head = events.length > 0 ? Number(events[events.length - 1]!.seq) : -1
  const subagent = header.origin === 'subagent' || typeof header.parentSession === 'string'
  const home = input.homeSessionId != null && header.id === input.homeSessionId
  let latestDirectUserSeq = -1
  let latestDirectUserMessageId: string | null = null
  for (const event of events) {
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    if (typeof event.data.id !== 'string' || event.data.id.length === 0) continue
    latestDirectUserSeq = Number(event.seq)
    latestDirectUserMessageId = event.data.id
  }
  let turnId: string | null = null
  let turnOpen = false
  let endKind: string | null = null
  let turnStartSeq = -1
  for (const event of events) {
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') {
      turnId = String(event.data.turn)
      turnOpen = true
      endKind = null
      turnStartSeq = Number(event.seq)
    } else if (event.type === 'turn/end' && typeof event.data?.turn === 'number') {
      turnId = String(event.data.turn)
      turnOpen = false
      endKind = event.data.reason?.kind ?? 'completed'
    }
  }
  const turnTerminal = !turnOpen && endKind != null && TERMINAL.has(endKind)
  const slice = events.filter((event) => Number(event.seq) >= turnStartSeq && turnStartSeq >= 0)
  const kinds = slice.filter((event) => event.type === 'user/message').map((event) => event.data?.source?.kind)
  const human = kinds.includes('user')
  const boop = kinds.some((kind) => kind === 'boop-command' || kind === 'boop-result')
  let ownership: TargetObservation['ownership'] = 'not_started'
  if (turnTerminal) ownership = 'ended'
  else if (turnOpen && human && boop) ownership = 'mixed'
  else if (turnOpen && human) ownership = 'user_takeover'
  else if (turnOpen && boop) ownership = 'exclusive'
  else if (turnOpen) ownership = 'unknown'
  const summary = [...events].reverse().map(eventText).find((text) => text.length > 0) ?? null
  const deliverable = turnTerminal && endKind === 'completed' && Boolean(summary && summary.trim().length > 0)
  const sourceGeneration = input.revision != null && String(input.revision).length > 0
    ? String(input.revision)
    : `${header.id ?? ''}:${header.version ?? ''}:${header.createdAt ?? ''}:${head}`
  return {
    reachable: true,
    busy: input.agentStatus === 'running',
    pendingHuman: endKind === 'blocked',
    archived: false,
    subagent,
    home,
    title: input.title || String(header.id ?? '未命名会话'),
    workspaceId: input.workspaceId,
    workspaceTitle: null,
    sourceGeneration,
    headSeq: head,
    latestDirectUserSeq,
    latestDirectUserMessageId,
    pendingMessage: input.pendingMessage === true,
    turnId,
    turnTerminal,
    ownership,
    approvalId: null,
    summary,
    deliverable,
    checks: [],
    artifacts: [],
    missing: deliverable ? [] : ['没有可核对的产物'],
    evidenceSeq: Math.max(0, head),
  }
}

export function contextFromEvents(
  events: OfficialEvent[],
  sessionId: string,
  sourceGeneration: string,
  limit: number,
  beforeSeq: number | null,
): ContextEvent[] {
  const rows: ContextEvent[] = []
  for (const event of ordered(events)) {
    if (beforeSeq != null && Number(event.seq) >= beforeSeq) continue
    const text = eventText(event)
    if (text.length === 0) continue
    rows.push({ seq: Number(event.seq), text, sessionId, sourceGeneration })
  }
  return rows.slice(-Math.max(0, limit))
}

export function logContainsMessage(events: OfficialEvent[], messageId: string): boolean {
  return ordered(events).some((event) => event.data?.id === messageId || event.data?.message?.id === messageId)
}

/** The latest direct human message. A tool call id is never that message. */
export function directHumanOrigin(events: OfficialEvent[], hintedId?: string | null): string | null {
  const orderedEvents = ordered(events)
  let origin: string | null = null
  for (const event of orderedEvents) {
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    if (typeof event.data.id !== 'string' || event.data.id.length === 0) continue
    origin = event.data.id
  }
  if (!origin) return null
  if (hintedId && hintedId !== origin) return null
  return origin
}

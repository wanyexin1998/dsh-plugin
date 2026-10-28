/**
 * BOOP main-scope reference guard.
 *
 * Installed as a normal (not prepended) agent/pre-step listener on the real
 * BOOP home agent. The host session-reference plugin prepends itself, awaits
 * next(), then reads mentions. This guard therefore runs inside that next()
 * and rewrites excluded mentions before the host pre-reads them.
 *
 * Fail closed: an unreadable policy turns every mention into a readable label
 * and does not leave a URI behind.
 */

import { formatSessionReferenceMention, parseSessionReferenceText } from '../../shared/session-mention.ts'

const installedGuards = new WeakSet<object>()

/** Remove schemes the host parser would read again from a denied label. */
export function neutralizeSessionText(text: string): string {
  let current = text
  for (let pass = 0; pass < 4; pass += 1) {
    const next = current
      .replace(/@\[(?:\\.|[^\\\]])*\]\((?:dsh-session:[^)\s]*)\)/gu, '（未读取的会话）')
      .replace(/dsh-session:[A-Za-z0-9_-]+/gu, '（未读取的会话）')
    if (next === current) break
    current = next
  }
  return current
}

export type ReferenceDecision = 'allow' | 'deny' | 'unknown'

export interface ReferencePolicy {
  decide(sessionId: string): ReferenceDecision
}

interface TextBlock {
  type?: unknown
  text?: unknown
}

interface MessageLike {
  source?: { kind?: unknown }
  content?: unknown
  [key: string]: unknown
}

function isUserTextMessage(message: MessageLike): boolean {
  const kind = message.source?.kind
  return kind === undefined || kind === 'user'
}

export function gateHomeReferences(messages: unknown[], policy: ReferencePolicy): unknown[] {
  if (!Array.isArray(messages)) return messages
  const rewritten: unknown[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      rewritten.push(message)
      continue
    }
    const record = message as MessageLike
    if (!isUserTextMessage(record) || !Array.isArray(record.content)) {
      rewritten.push(message)
      continue
    }
    let changed = false
    const notes: string[] = []
    const content = record.content.map((block) => {
      if (!block || typeof block !== 'object') return block
      const textBlock = block as TextBlock
      if (textBlock.type !== 'text' || typeof textBlock.text !== 'string') return block
      let parsed: ReturnType<typeof parseSessionReferenceText>
      try {
        parsed = parseSessionReferenceText(textBlock.text)
      } catch {
        changed = true
        notes.push('有一条会话引用无法识别，已保留原文说明，没有读取它。')
        return { ...textBlock, text: neutralizeSessionText(textBlock.text) }
      }
      if (parsed.references.length === 0) return block as TextBlock
      const decisions = parsed.references.map((reference) => ({ reference, decision: policy.decide(reference.sessionId) }))
      if (decisions.every((item) => item.decision === 'allow')) return block as TextBlock
      changed = true
      const allowed = decisions.filter((item) => item.decision === 'allow').map((item) => item.reference)
      const blocked = decisions.filter((item) => item.decision !== 'allow')
      const restored = allowed.map((reference) => formatSessionReferenceMention(reference)).join(' ')
      const visible = neutralizeSessionText(parsed.text)
      const text = restored.length > 0 ? `${visible}\n${restored}` : visible
      notes.push(
        blocked.some((item) => item.decision === 'unknown')
          ? '有会话引用暂时无法确认是否可以读取，已先不读取。'
          : '有会话引用不在波波可以读取的范围内，已保留名称但没有读取内容。',
      )
      return { ...textBlock, text }
    })
    if (!changed) {
      rewritten.push(message)
      continue
    }
    rewritten.push({
      ...(record as object),
      content: [...content, { type: 'text', text: notes.join('') }],
    })
  }
  return rewritten
}

/**
 * Register the guard on one agent context. Returns false when the agent has
 * no event hook, which the home service treats as send=false.
 */
export function installHomeReferenceGuard(agent: { ctx?: { on?: Function } }, policy: ReferencePolicy): boolean {
  const context = agent.ctx
  const on = context?.on
  if (!context || typeof on !== 'function') return false
  if (installedGuards.has(context)) return true
  on.call(context, 'agent/pre-step', async (_payload: unknown, next: () => Promise<{ kind?: string; messages?: unknown[] }>) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
    return { ...decision, messages: gateHomeReferences(decision.messages, policy) }
  })
  installedGuards.add(context)
  return true
}

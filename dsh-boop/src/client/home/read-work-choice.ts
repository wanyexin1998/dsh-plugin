/**
 * Read a work-choice card from one boop_catalog tool result.
 * Assistant markdown and partial JSON never become buttons.
 */

import type { WorkCandidate, WorkCatalog } from '../../shared/mvp-contract.ts'

export interface WorkChoice {
  originUserMessageId: string | null
  sourceSeq: number | null
  candidates: WorkCandidate[]
}

export interface ToolResultNodeLike {
  kind?: unknown
  name?: unknown
  isError?: unknown
  call?: unknown
  content?: unknown
}

function textOf(node: ToolResultNodeLike): string | null {
  if (!Array.isArray(node.content) || node.content.length !== 1) return null
  const block = node.content[0] as { type?: unknown; text?: unknown }
  if (!block || block.type !== 'text' || typeof block.text !== 'string' || block.text.trim() === '') return null
  return block.text
}

function isDirectUser(node: ToolResultNodeLike & { role?: unknown; source?: { kind?: unknown } }): boolean {
  if (node.kind === 'tool-result' || node.kind === 'tool-call') return false
  if (node.kind === 'user' || node.kind === 'user-message' || node.role === 'user') return true
  return node.source?.kind === 'user'
}

export function readWorkChoice(nodes: unknown): WorkChoice | null {
  if (!Array.isArray(nodes)) return null
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index] as ToolResultNodeLike & { role?: unknown; source?: { kind?: unknown } }
    if (!node || typeof node !== 'object') continue
    if (isDirectUser(node)) return null
    if (node.kind !== 'tool-result' || node.name !== 'boop_catalog' || node.isError || node.call == null) continue
    const text = textOf(node)
    if (text === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const reply = parsed as { schemaVersion?: unknown; kind?: unknown; ok?: unknown; data?: WorkCatalog }
    if (reply.schemaVersion !== 2 || reply.kind !== 'boop.catalog' || reply.ok !== true || reply.data?.mode !== 'work') return null
    if (!Array.isArray(reply.data.candidates) || reply.data.candidates.length > 5) return null
    for (const candidate of reply.data.candidates) {
      if (!candidate || typeof candidate.sessionId !== 'string' || typeof candidate.mention !== 'string' || typeof candidate.title !== 'string') {
        return null
      }
    }
    return {
      originUserMessageId: reply.data.originUserMessageId,
      sourceSeq: reply.data.sourceSeq,
      candidates: reply.data.candidates,
    }
  }
  return null
}

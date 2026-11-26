/**
 * Release the global slot when the target session's turn ends.
 *
 * `boop_dispatch` marks a delivered followup `running`. That state occupies
 * the slot. A later `turn/end` on that same session frees it: `completed`
 * becomes `settled`; any other ending (error, aborted, unknown) goes back to
 * the delivery receipt `accepted`. An error ending is not a finished task.
 */

import type { BoopRepository } from '../persistence/repository.ts'

export function sessionIdFromEventTarget(session: unknown): string | null {
  if (typeof session === 'string' && session.trim() !== '') return session
  if (!session || typeof session !== 'object') return null
  const record = session as {
    id?: unknown
    sessionId?: unknown
    header?: { id?: unknown }
    session?: { id?: unknown; header?: { id?: unknown } }
  }
  const nested = record.session?.header?.id ?? record.session?.id
  if (typeof record.header?.id === 'string' && record.header.id !== '') return record.header.id
  if (typeof nested === 'string' && nested !== '') return nested
  if (typeof record.id === 'string' && record.id !== '') return record.id
  if (typeof record.sessionId === 'string' && record.sessionId !== '') return record.sessionId
  return null
}

function turnEndOf(event: unknown): { kind: string; detail: string } | null {
  if (!event || typeof event !== 'object') return null
  const record = event as { type?: unknown; data?: { reason?: { kind?: unknown; error?: { message?: unknown } } } }
  if (record.type !== 'turn/end') return null
  const reason = record.data?.reason
  const kind = typeof reason?.kind === 'string' && reason.kind !== '' ? reason.kind : 'unknown'
  const message = reason?.error?.message
  const detail = typeof message === 'string' ? message.trim() : ''
  return { kind, detail }
}

/**
 * Free the running followup for this session. A second call finds nothing
 * and writes nothing. A turn ending on another session is ignored.
 */
export function releaseRunningOnTurnEnd(
  repo: BoopRepository,
  scopeId: string,
  sessionId: string | null,
  event: unknown,
): { actionId: string; to: 'settled' | 'accepted'; reason: string } | null {
  const ended = turnEndOf(event)
  if (!ended || sessionId === null || sessionId === '') return null
  const action = repo.runningActionForSession(scopeId, sessionId)
  if (!action) return null
  const to: 'settled' | 'accepted' = ended.kind === 'completed' ? 'settled' : 'accepted'
  repo.markActionState(scopeId, action.id, to)
  const text = ended.detail === '' ? ended.kind : `${ended.kind}: ${ended.detail}`
  repo.audit(scopeId, 'dispatch/turn-ended', action.id, 'system', `${text} -> ${to}`.slice(0, 300))
  return { actionId: action.id, to, reason: ended.kind }
}

/** A delivered followup occupies the slot until its turn ends. */
export function holdSlotForTurn(repo: BoopRepository, scopeId: string, actionId: string): boolean {
  const action = repo.getAction(scopeId, actionId)
  if (!action || action.state !== 'accepted') return false
  repo.markActionState(scopeId, actionId, 'running')
  return true
}

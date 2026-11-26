/**
 * One followup to an existing session.
 *
 * This is the body of the model tool `boop_dispatch` and of the PoC caller
 * that drives the same function when the model cannot choose the tool.
 * It uses the dispatcher already covered by the host idempotency suite:
 * queue only, one global slot, message id equal to the action id.
 * After a delivery receipt it marks the action `running` so the slot stays
 * occupied until `turn/end`.
 */

import type { BoopRepository } from '../persistence/repository.ts'
import { DshAdapter } from '../transport/dsh-adapter.ts'
import { Dispatcher, type DispatchOutcome } from './dispatcher.ts'
import { holdSlotForTurn } from './turn-release.ts'

export interface FollowupRequest {
  requestId?: unknown
  targetSessionId?: unknown
  instruction?: unknown
}

export interface FollowupReceipt {
  ok: boolean
  kind: 'accepted' | 'duplicate' | 'in-flight' | 'rejected'
  reason: string | null
  actionId: string
  messageId: string | null
  slotHeld: boolean
}

const REQUEST_ID = /^[\w.:-]{1,128}$/u

function refusal(reason: string, actionId = '', slotHeld = false): FollowupReceipt {
  return { ok: false, kind: 'rejected', reason, actionId, messageId: null, slotHeld }
}

function parse(input: FollowupRequest): { requestId: string; targetSessionId: string; instruction: string } | null {
  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : ''
  const targetSessionId = typeof input.targetSessionId === 'string' ? input.targetSessionId.trim() : ''
  const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : ''
  if (!REQUEST_ID.test(requestId)) return null
  if (targetSessionId === '' || targetSessionId.length > 200) return null
  if (instruction === '' || instruction.length > 16_000) return null
  return { requestId, targetSessionId, instruction }
}

function hostDispatcher(ctx: any, repo: BoopRepository, scopeId: string): Dispatcher {
  const adapter = new DshAdapter({ ctx })
  const knownMessageIds = (): ReadonlySet<string> => {
    try {
      return new Set<string>(ctx.boop?.proxyMessageIds?.() ?? [])
    } catch {
      return new Set<string>()
    }
  }
  return new Dispatcher({
    repo,
    scopeId,
    enqueue: (input) => adapter.enqueueProxy(input),
    knownMessageIds,
    pendingFor: (sessionId) => adapter.pendingProxyCommands(sessionId, knownMessageIds()),
    gateDecision: (claimed) => ctx.boop.gate().decide(claimed),
    evidence: (sessionId, options) => adapter.readDurableTrace(sessionId, { sinceMs: options.sinceMs, clean: options.clean }),
    outboxState: (actionId) => repo.outboxState(scopeId, actionId),
    actionCreatedAt: (actionId) => repo.actionCreatedAt(scopeId, actionId),
    flush: (sessionId) => adapter.flush(sessionId),
    now: () => new Date().toISOString(),
  })
}

function fromOutcome(outcome: DispatchOutcome, slotHeld: boolean): FollowupReceipt {
  if (outcome.kind === 'accepted') {
    return { ok: true, kind: 'accepted', reason: null, actionId: outcome.actionId, messageId: outcome.messageId, slotHeld }
  }
  if (outcome.kind === 'duplicate') {
    return {
      ok: true,
      kind: 'duplicate',
      reason: outcome.reason,
      actionId: outcome.actionId,
      messageId: outcome.messageId,
      slotHeld: false,
    }
  }
  if (outcome.kind === 'unknown') {
    return { ok: false, kind: 'rejected', reason: outcome.reason, actionId: outcome.actionId, messageId: null, slotHeld: true }
  }
  return {
    ok: false,
    kind: 'rejected',
    reason: outcome.reason,
    actionId: outcome.actionId,
    messageId: null,
    slotHeld: outcome.reason === 'SLOT_HELD',
  }
}

export async function dispatchFollowup(ctx: any, input: FollowupRequest): Promise<FollowupReceipt> {
  const parsed = parse(input ?? {})
  if (!parsed) return refusal('INVALID_REQUEST')
  let writeMode = false
  try {
    writeMode = ctx?.boop?.isWriteModeEnabled?.() === true
  } catch {
    writeMode = false
  }
  if (!writeMode) return refusal('WRITE_MODE_OFF')

  const storage = ctx?.boop?.storage?.()
  const repo = storage?.repo as BoopRepository | undefined
  const scopeId = typeof storage?.identity?.scopeId === 'string' ? storage.identity.scopeId : ''
  if (!repo || scopeId === '') return refusal('LEDGER_UNAVAILABLE')
  const fence = storage.checkWrite?.()
  if (!fence || fence.ok !== true) return refusal('LEDGER_READ_ONLY')

  const intent = `dispatch:${parsed.requestId}`
  const existingTask = repo.taskByIntent(scopeId, intent)
  const existingAction = existingTask ? repo.latestActionForTask(scopeId, existingTask.id) : null
  if (existingAction && (existingAction.state === 'running' || existingAction.state === 'outcome_unknown')) {
    return {
      ok: true,
      kind: 'in-flight',
      reason: null,
      actionId: existingAction.id,
      messageId: existingAction.messageId,
      slotHeld: true,
    }
  }
  if (existingAction && (existingAction.state === 'accepted' || existingAction.state === 'settled')) {
    return {
      ok: true,
      kind: 'duplicate',
      reason: 'ALREADY_ACCEPTED',
      actionId: existingAction.id,
      messageId: existingAction.messageId,
      slotHeld: false,
    }
  }
  if (existingAction && (existingAction.state === 'rejected' || existingAction.state === 'stopped')) {
    return refusal('ACTION_TERMINAL', existingAction.id)
  }

  const holder = repo.slotHolder(scopeId)
  if (holder && holder.actionId !== (existingAction?.id ?? '')) {
    return refusal('SLOT_HELD', holder.actionId, true)
  }

  const scope = repo.getScope(scopeId)
  if (!scope) return refusal('SCOPE_UNKNOWN')
  const task =
    existingTask ??
    repo.createTask({
      scopeId,
      goal: parsed.instruction.slice(0, 240),
      intentRef: intent,
    })
  const instruction = existingAction ? (repo.actionInstruction(scopeId, existingAction.id) ?? parsed.instruction) : parsed.instruction
  const targetSessionId = existingAction?.targetSessionId || parsed.targetSessionId
  const dispatcher = hostDispatcher(ctx, repo, scopeId)
  let actionId = existingAction?.id ?? ''
  if (actionId === '') {
    const planned = dispatcher.plan({
      taskId: task.id,
      expectedTaskVersion: task.version,
      targetSessionId,
      instruction,
      mode: 'queue',
      originRef: 'tool:boop_dispatch',
      policyEpoch: scope.policyEpoch,
    })
    if (planned.error) return refusal(planned.error)
    actionId = planned.actionId
  }

  try {
    const gate = ctx.boop.gate()
    gate.track({
      sessionId: targetSessionId,
      actionId,
      messageId: actionId,
      reason: 'boop_dispatch followup',
    })
    gate.release([actionId])
  } catch {
    return refusal('GATE_UNAVAILABLE', actionId)
  }

  const outcome = await dispatcher.dispatch({
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId,
    instruction,
    mode: 'queue',
    originRef: 'tool:boop_dispatch',
    policyEpoch: scope.policyEpoch,
    actionId,
  })
  if (outcome.kind === 'accepted') holdSlotForTurn(repo, scopeId, outcome.actionId)
  return fromOutcome(outcome, outcome.kind === 'accepted' || outcome.kind === 'unknown')
}

/**
 * User-facing work projection.
 *
 * Delivery, confirmation, and verification stay separate. Human acceptance never
 * rewrites check evidence into passed.
 */

import type {
  ConfirmationView,
  DeliveryState,
  ExecutionState,
  ProductState,
  ResultView,
  TaskView,
  VerificationCheck,
  VerificationView,
} from '../../shared/mvp-contract.ts'

export interface ProjectionAction {
  actionId: string
  executionState: ExecutionState
  stopRequested: boolean
  queueReason: string | null
  ownership: string
  nativeApprovalId: string | null
}

export interface ProjectionResult {
  resultId: string
  taskVersion: number
  actionId: string
  kind: ResultView['kind']
  outcome: ResultView['outcome']
  deliverable: boolean
  summary: string
  artifacts: ResultView['artifacts']
  evidence: ResultView['evidence']
  checks: VerificationCheck[]
  missing: string[]
  deliveryState: DeliveryState
  createdAt: string
}

export interface ProjectionInput {
  taskId: string
  taskVersion: number
  stateSeq: number
  title: string
  updatedAt: string
  engineVersion: number
  recovery: boolean
  target: { sessionId: string; workspaceId: string | null; sessionTitle: string; workspaceTitle: string | null }
  action: ProjectionAction | null
  result: ProjectionResult | null
  acceptance: { acceptanceId: string; acceptedAt: string; appliedTaskVersion: number } | null
}

const OCCUPYING = new Set(['dispatching', 'accepted', 'running', 'outcome_unknown'])

export function verificationFromChecks(checks: VerificationCheck[]): VerificationView {
  if (checks.length === 0) {
    return { state: 'not_checked', summary: '还没有可定位的检查结果。', checks }
  }
  const passed = checks.filter((check) => check.state === 'passed' && check.evidence.length > 0)
  const failed = checks.filter((check) => check.state === 'failed')
  if (failed.length > 0 && passed.length > 0) {
    return { state: 'partial', summary: '有的检查通过了，有的没有。', checks }
  }
  if (failed.length > 0) return { state: 'failed', summary: '有检查没有通过。', checks }
  if (passed.length === checks.length) return { state: 'passed', summary: '记录里的检查都通过了。', checks }
  return { state: 'unknown', summary: '检查结果还不完整，不能算通过。', checks }
}

function confirmationOf(input: ProjectionInput, delivered: boolean): ConfirmationView {
  if (input.acceptance && input.acceptance.appliedTaskVersion === input.taskVersion) {
    return {
      state: 'accepted',
      acceptanceId: input.acceptance.acceptanceId,
      acceptedAt: input.acceptance.acceptedAt,
      appliedTaskVersion: input.acceptance.appliedTaskVersion,
    }
  }
  if (delivered && input.result?.kind === 'final' && input.result.deliverable && input.result.taskVersion === input.taskVersion) {
    return { state: 'pending' }
  }
  return { state: 'unavailable' }
}

export function projectTask(input: ProjectionInput): TaskView {
  const action = input.action
  const verification = verificationFromChecks(input.result?.checks ?? [])
  const terminal = action === null || !OCCUPYING.has(action.executionState)
  const delivered =
    terminal &&
    input.result !== null &&
    input.result.deliverable &&
    input.result.kind === 'final' &&
    input.result.taskVersion === input.taskVersion
  const confirmation = confirmationOf(input, delivered)
  let productState: ProductState = 'needs_attention'
  let statusText = '这件事需要再看一下。'
  let reason: string | null = null
  const stopping = action?.stopRequested === true && action.executionState !== 'stopped' && action.executionState !== 'settled' && action.executionState !== 'rejected'

  if (input.engineVersion < 2) {
    productState = 'needs_attention'
    statusText = '这是更早版本留下的工作，不会自动继续。'
    reason = 'legacy'
  } else if (action?.executionState === 'outcome_unknown' || action?.ownership === 'user_takeover' || action?.ownership === 'mixed' || action?.queueReason === 'context_changed' || input.recovery) {
    productState = 'needs_attention'
    statusText = '暂时无法确认请求是否送达，我会先核对，避免重复执行。'
    reason = action?.ownership === 'user_takeover' ? 'user_takeover' : action?.queueReason === 'context_changed' ? 'context_changed' : 'outcome_unknown'
  } else if (stopping && (action?.executionState === 'running' || action?.executionState === 'accepted' || action?.executionState === 'dispatching')) {
    productState = 'stopping'
    statusText = '已停止后续安排，正在确认当前执行是否停下。'
  } else if (action?.nativeApprovalId && action.executionState === 'running') {
    productState = 'awaiting_native_approval'
    statusText = '这项操作需要你在原会话确认。'
  } else if (action?.executionState === 'running') {
    productState = 'running'
    statusText = '正在处理，有结果会告诉你。'
  } else if (action?.executionState === 'accepted') {
    productState = 'accepted'
    statusText = '已交给原会话，等待开始处理。'
  } else if (action?.executionState === 'dispatching') {
    productState = 'dispatching'
    statusText = '正在交给原会话。'
  } else if (action?.queueReason === 'target_busy' && action.executionState === 'planned') {
    productState = 'waiting_target'
    statusText = '原会话正在处理其他工作，空闲后我会再核对并继续。'
  } else if (action?.executionState === 'planned') {
    productState = 'queued'
    statusText = action.queueReason === 'global_slot' ? '前面还有一件正在处理的工作，这件在后面等。' : '已记下，等待交给原会话。'
  } else if (action?.executionState === 'stopped' || action?.executionState === 'rejected') {
    productState = 'stopped'
    statusText = '这件工作已停止，不会再自动继续。'
  } else if (delivered) {
    productState = 'delivered'
    statusText = confirmation.state === 'accepted' ? '你已确认收下。' : '已交付，可以查看结果。'
  } else if (input.result) {
    productState = 'received_reply'
    statusText = '已收到回复，结果还需要核对。'
  } else if (terminal) {
    productState = 'stopped'
    statusText = '这件工作已经结束。'
  }

  const actions: TaskView['availableActions'] = ['view']
  if (input.target.sessionId) actions.push('open_session')
  if (productState === 'needs_attention') actions.push('reconcile')
  if (['queued', 'waiting_target', 'dispatching', 'accepted', 'running', 'awaiting_native_approval'].includes(productState)) {
    actions.push('stop')
  }
  if (['delivered', 'received_reply', 'stopped'].includes(productState)) actions.push('continue')
  if (productState === 'delivered' && confirmation.state === 'pending') actions.push('confirm')

  const latestResult: ResultView | null = input.result
    ? {
        resultId: input.result.resultId,
        taskVersion: input.result.taskVersion,
        actionId: input.result.actionId,
        kind: input.result.kind,
        outcome: input.result.outcome,
        summary: input.result.summary,
        artifacts: input.result.artifacts,
        evidence: input.result.evidence,
        missing: input.result.missing,
        verification,
        confirmation,
        deliveryState: input.result.deliveryState,
        createdAt: input.result.createdAt,
      }
    : null

  return {
    taskId: input.taskId,
    taskVersion: input.taskVersion,
    stateSeq: input.stateSeq,
    title: input.title,
    target: input.target,
    productState,
    statusText,
    needsAttentionReason: reason,
    latestAction: action
      ? { actionId: action.actionId, executionState: action.executionState, stopRequested: action.stopRequested }
      : null,
    latestResult,
    confirmation,
    verification,
    availableActions: actions,
    updatedAt: input.updatedAt,
  }
}

export function homeSummary(items: TaskView[]): TaskView[] {
  const rank: Record<ProductState, number> = {
    needs_attention: 0,
    awaiting_native_approval: 1,
    delivered: 2,
    received_reply: 3,
    waiting_target: 4,
    stopping: 5,
    running: 6,
    accepted: 7,
    dispatching: 8,
    queued: 9,
    stopped: 10,
  }
  return [...items].sort((a, b) => rank[a.productState] - rank[b.productState] || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3)
}

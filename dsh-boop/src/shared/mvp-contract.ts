/**
 * BOOP v0.2 wire contract.
 *
 * Appendix A of the v0.2 plan is the only field source. The UI must not render
 * internal ids, versions, watermarks, or raw error codes as the primary copy.
 */

export const MVP_SCHEMA_VERSION = 2 as const

export type Id = string
export type ISODate = string

export interface ReplyError {
  code: string
  message: string
  retryable: boolean
  diagnosticId?: string
  taskId?: Id
  actionId?: Id
  appliedTaskVersion?: number
}

export type Reply<K extends string, T> =
  | { schemaVersion: 2; kind: K; ok: true; requestId?: string; replayed?: boolean; data: T }
  | { schemaVersion: 2; kind: K; ok: false; requestId?: string; error: ReplyError }

export interface HomeCapabilities {
  send: boolean
  readSources: boolean
  delegate: boolean
  stop: boolean
  reasonCodes: string[]
}

export type HomeView =
  | {
      state: 'ready'
      mainSessionId: Id
      bindingVersion: number
      capabilities: HomeCapabilities
      migration?: { legacySessionId: Id; carriedContextRef: string | null }
    }
  | {
      state: 'repair_required' | 'unavailable'
      reasonCode: string
      message: string
      retryable: boolean
      mainSessionId?: Id
    }

export interface EvidenceRef {
  sessionId: Id
  sourceGeneration: string
  seq: number
  hash?: string
  label?: string
}

export interface ArtifactRef {
  kind: 'file' | 'url' | 'session'
  label: string
  ref: string
  evidence: EvidenceRef
  contentHash?: string
}

export interface WorkCandidate {
  sessionId: Id
  workspaceId: Id | null
  title: string
  workspaceTitle: string | null
  mention: string
  selectionKey: string
  activity: 'idle' | 'running' | 'unknown'
  lastActivityAt: ISODate | null
  preview: string | null
}

export interface WorkCatalog {
  mode: 'work'
  originUserMessageId: Id | null
  sourceSeq: number | null
  generatedAt: ISODate
  candidates: WorkCandidate[]
  truncated: boolean
}

export type ProductState =
  | 'queued'
  | 'waiting_target'
  | 'dispatching'
  | 'accepted'
  | 'running'
  | 'awaiting_native_approval'
  | 'received_reply'
  | 'delivered'
  | 'needs_attention'
  | 'stopping'
  | 'stopped'

export type ExecutionState =
  | 'planned'
  | 'dispatching'
  | 'accepted'
  | 'running'
  | 'settled'
  | 'stopped'
  | 'outcome_unknown'
  | 'rejected'

export type DeliveryState = 'pending' | 'sending' | 'sent' | 'unknown' | 'suppressed'

export interface VerificationCheck {
  criterion: string
  state: 'passed' | 'failed' | 'unknown'
  evidence: EvidenceRef[]
}

export interface VerificationView {
  state: 'not_checked' | 'pending' | 'passed' | 'failed' | 'partial' | 'unknown'
  summary: string
  checks: VerificationCheck[]
}

export interface ConfirmationView {
  state: 'unavailable' | 'pending' | 'accepted'
  acceptanceId?: Id
  acceptedAt?: ISODate
  appliedTaskVersion?: number
}

export interface ResultView {
  resultId: Id
  taskVersion: number
  actionId: Id
  kind: 'progress' | 'blocked' | 'final' | 'stopped'
  outcome: 'completed' | 'failed' | 'stopped' | 'inconclusive' | 'blocked' | 'progress'
  summary: string
  artifacts: ArtifactRef[]
  evidence: EvidenceRef[]
  missing: string[]
  verification: VerificationView
  confirmation: ConfirmationView
  deliveryState: DeliveryState
  createdAt: ISODate
}

export interface TaskView {
  taskId: Id
  taskVersion: number
  stateSeq: number
  title: string
  target: { sessionId: Id; workspaceId: Id | null; sessionTitle: string; workspaceTitle: string | null }
  productState: ProductState
  statusText: string
  needsAttentionReason: string | null
  latestAction: { actionId: Id; executionState: ExecutionState; stopRequested: boolean } | null
  latestResult: ResultView | null
  confirmation: ConfirmationView
  verification: VerificationView
  availableActions: Array<'view' | 'open_session' | 'stop' | 'continue' | 'confirm' | 'reconcile'>
  updatedAt: ISODate
}

export interface TaskPage {
  items: TaskView[]
  nextCursor: string | null
  syncedAt: ISODate
}

export type CatalogValue =
  | WorkCatalog
  | { mode: 'tasks'; tasks: TaskView[]; truncated: boolean }
  | { mode: 'capabilities'; capabilities: HomeCapabilities }

export interface ContextView {
  targetSessionId: Id | null
  taskId: Id | null
  contextToken: Id | null
  sourceGeneration: string | null
  headSeq: number | null
  latestDirectUserSeq: number | null
  body: string
  evidence: EvidenceRef[]
  truncated: boolean
  nextBeforeSeq: number | null
  memoryFreshness: 'current' | 'stale' | 'unknown'
}

export interface DispatchArgs {
  requestId: string
  targetSessionId: Id
  contextToken: Id
  goal: string
  instruction: string
  criteria?: string[]
  exclusions?: string[]
}

export interface StopArgs {
  requestId: string
  taskId: Id
  expectedTaskVersion: number
}

export interface ContinueArgs extends StopArgs {
  contextToken: Id
  instruction: string
  goal?: string
  criteria?: string[]
  exclusions?: string[]
}

export interface ConfirmArgs extends StopArgs {
  resultId: Id
  decision: 'accept'
}

export interface DispatchReceipt {
  taskId: Id
  actionId: Id
  appliedTaskVersion: number
  disposition: 'queued' | 'dispatched'
  productState: ProductState
  reasonCode: string | null
}

export interface ControlReceipt {
  taskId: Id
  appliedTaskVersion: number
  actionId: Id | null
  operation: 'stop' | 'continue'
  disposition: 'queued' | 'stop_requested' | 'stopped' | 'stopped_future_only'
  productState: ProductState
  reasonCode: string | null
}

export interface AcceptanceReceipt {
  acceptanceId: Id
  taskId: Id
  resultId: Id
  appliedTaskVersion: number
  acceptedAt: ISODate
  verificationChangedToPassed: false
}

export interface AccessView {
  mode: 'none' | 'selected' | 'all_authorized'
  workspaceIds: Id[]
  sessionIds: Id[]
  policyEpoch: number
  grantedBy: string | null
  inherited: boolean
}

export interface AccessUpdateArgs {
  requestId: string
  expectedPolicyEpoch: number
  mode: AccessView['mode']
  workspaceIds: Id[]
  sessionIds: Id[]
}

export function okReply<K extends string, T>(
  kind: K,
  data: T,
  extra: { requestId?: string; replayed?: boolean } = {},
): Reply<K, T> {
  return {
    schemaVersion: 2,
    kind,
    ok: true,
    ...(extra.requestId === undefined ? {} : { requestId: extra.requestId }),
    ...(extra.replayed ? { replayed: true } : {}),
    data,
  }
}

export function failReply<K extends string>(
  kind: K,
  error: ReplyError,
  requestId?: string,
): Reply<K, never> {
  return {
    schemaVersion: 2,
    kind,
    ok: false,
    ...(requestId === undefined ? {} : { requestId }),
    error,
  }
}

export function textOf(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

export function stringList(value: unknown, itemMax: number, listMax: number): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > listMax) return null
  const out: string[] = []
  for (const item of value) {
    const text = textOf(item, itemMax)
    if (text === null) return null
    out.push(text)
  }
  return out
}

export function validateDispatchArgs(raw: unknown): { ok: true; value: DispatchArgs } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, message: '参数需要是一个对象。' }
  const input = raw as Record<string, unknown>
  const requestId = textOf(input.requestId, 128)
  const targetSessionId = textOf(input.targetSessionId, 256)
  const contextToken = textOf(input.contextToken, 128)
  const goal = textOf(input.goal, 240)
  const instruction = textOf(input.instruction, 16_000)
  const criteria = stringList(input.criteria, 1_000, 20)
  const exclusions = stringList(input.exclusions, 1_000, 20)
  if (!requestId || !targetSessionId || !contextToken || !goal || !instruction || !criteria || !exclusions) {
    return { ok: false, message: '委托需要目标、目标和限制都写清楚，空白内容不算。' }
  }
  return { ok: true, value: { requestId, targetSessionId, contextToken, goal, instruction, criteria, exclusions } }
}

export function validateStopArgs(raw: unknown): { ok: true; value: StopArgs } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, message: '参数需要是一个对象。' }
  const input = raw as Record<string, unknown>
  const requestId = textOf(input.requestId, 128)
  const taskId = textOf(input.taskId, 128)
  const expectedTaskVersion = input.expectedTaskVersion
  if (!requestId || !taskId || typeof expectedTaskVersion !== 'number' || !Number.isInteger(expectedTaskVersion) || expectedTaskVersion <= 0) {
    return { ok: false, message: '停止需要准确的工作和版本。' }
  }
  return { ok: true, value: { requestId, taskId, expectedTaskVersion } }
}

export function unwrapRequest(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {}
  const obj = input as Record<string, unknown>
  if (obj.request && typeof obj.request === 'object') return obj.request as Record<string, unknown>
  return obj
}

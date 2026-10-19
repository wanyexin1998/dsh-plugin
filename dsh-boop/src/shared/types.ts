/**
 * BOOP shared types — implementation of the frozen design contracts
 * (baseline/appendix/boop-contracts.ts, frozen at v1.2-FROZEN-R1).
 *
 * These are BOOP's own domain types. The DshAdapter binding against the real
 * rc.2 host surface is owned by src/host/dsh-adapter and verified by
 * tests/host/*.test.mjs (E00-01/E00-02).
 */

export type TaskLife =
  | 'draft'
  | 'active'
  | 'paused'
  | 'blocked'
  | 'recovery_required'
  | 'completed'
  | 'cancelled'

export type Verification =
  | 'not_requested'
  | 'pending'
  | 'passed'
  | 'failed'
  | 'waived'

export type ActionState =
  | 'planned'
  | 'awaiting_approval'
  | 'dispatching'
  | 'accepted'
  | 'running'
  | 'settled'
  | 'stopped'
  | 'outcome_unknown'
  | 'rejected'

export interface EvidenceRef {
  scopeId: string
  sessionId: string
  sourceGeneration: string
  seq: number
  hash?: string
  artifactRef?: string
}

export interface VerifiedActor {
  ownerId: string
  scopeId: string
  channel: 'dsh' | 'dingtalk' | 'feishu'
  bindingId?: string
}

export interface Task {
  id: string
  scopeId: string
  goal: string
  version: number
  lifecycle: TaskLife
  verification: Verification
  criteria: string[]
  exclusions: string[]
}

export interface ActionProposal {
  taskId: string
  expectedVersion: number
  targetSessionId: string
  instruction: string
  mode: 'queue' | 'steer'
  evidenceRefs: EvidenceRef[]
}

export interface CommandEnvelope {
  scopeId: string
  taskId: string
  taskVersion: number
  actionId: string
  messageId: string
  policyEpoch: number
  payloadHash: string
  initiatorRef: string
  instruction: string
  mode: 'queue' | 'steer'
}

export interface ApprovalBinding {
  id: string
  actionId: string
  taskVersion: number
  policyEpoch: number
  payloadHash: string
  requestingOwner: string
  expiresAt: string
  nonceHash: string
}

export interface Snapshot {
  scopeId: string
  ownerId: string
  version: number
  body: string
  coverage: Record<string, { sourceGeneration: string; throughSeq: number }>
  freshness: 'current' | 'stale' | 'unknown'
}

export interface MemoryChange {
  status?: 'active' | 'disputed'
  op: 'add' | 'edit' | 'supersede' | 'conflict'
  factId?: string
  kind: string
  text: string
  authority: string
  evidenceRefs: EvidenceRef[]
  supersedes: string[]
  /**
   * Optional stable subject of the claim (e.g. `deploy-policy`,
   * `deadline:e03-02`). Two facts are only compared for a conflict when they
   * share `kind + subjectKey`; a different key marks an independent fact.
   * Absent means "unknown", which keeps the conservative rule (see
   * `MemoryCommitter`): inequality alone never resolves a disagreement.
   */
  subjectKey?: string
}

export interface MemoryProposal {
  schemaVersion: 1
  scopeId: string
  sessionId: string
  /**
   * Source generation this proposal read from. Required for an honest coverage
   * key (`<sessionId>#<generation>`); extraction always passes it, older callers
   * may omit it and the committer falls back to the prior snapshot key.
   */
  sourceGeneration?: string
  fromSeq: number
  toSeq: number
  baselineVersion: number
  changes: MemoryChange[]
  unresolved: string[]
}

export interface InboundEnvelope {
  channel: 'dingtalk' | 'feishu'
  appId: string
  tenantId: string
  actorId: string
  conversationId: string
  eventId: string
  messageId: string
  timestamp: string
  text: string
  verifiedBindingId: string
}

export interface ReadTarget {
  scopeId: string
  sessionId: string
}

export interface DshAdapter {
  capabilities(): Promise<Record<string, boolean>>
  listTargets(scopeId: string): Promise<Array<{ workspaceId?: string; sessionId: string; running: boolean; title?: string }>>
  readHistory(target: ReadTarget, afterSeq: number, signal: AbortSignal): AsyncIterable<unknown>
  readInbox(target: ReadTarget, signal: AbortSignal): Promise<Array<{ messageId: string; source: unknown }>>
  ensureMain(scopeId: string, presetId: string, signal: AbortSignal): Promise<{ sessionId: string }>
  /** Adapter must preserve agent provenance; must NOT send a fake human prompt. */
  enqueueProxy(envelope: CommandEnvelope, signal: AbortSignal): Promise<{ messageId: string; accepted: boolean }>
  flush(target: ReadTarget, signal: AbortSignal): Promise<void>
  cancelOwned(target: ReadTarget, actionId: string, signal: AbortSignal): Promise<{ requested: boolean; settled: boolean }>
}

export interface ChannelAdapter {
  connect(signal: AbortSignal): Promise<void>
  verifyAndNormalize(raw: unknown): Promise<InboundEnvelope | null>
  acknowledgeReceipt(raw: unknown): Promise<void>
  sendReply(origin: InboundEnvelope, text: string, logicalReplyId: string): Promise<{ receipt: string }>
  disconnect(): Promise<void>
}

/** BOOP logical API error codes (frozen: 03§07). */
export type BoopErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'VERSION_UNSUPPORTED'
  | 'SCOPE_DENIED'
  | 'TARGET_AMBIGUOUS'
  | 'TASK_VERSION_CONFLICT'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_STALE'
  | 'RECOVERY_REQUIRED'
  | 'OUTCOME_UNKNOWN'
  | 'MEMORY_STALE'
  | 'WRITER_HELD'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'

/** Host runtime version gate (frozen: 0.2.1-rc.2, commit 332895e0…). */
export const DSH_TARGET = {
  profileVersion: '0.2.1-rc.2',
  commit: '332895e0f7c9d4dbfb29729f5eb367fa263ff986',
} as const

/** Data-domain scope id: stable per normalized DSH_HOME + local owner identity (03§02). */
export interface ScopeIdentity {
  scopeId: string
  ownerId: string
  dshHomeFingerprint: string
}

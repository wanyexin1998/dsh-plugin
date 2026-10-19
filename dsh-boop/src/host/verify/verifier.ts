/**
 * BOOP evidence verification engine (E05-02) — framework-free core.
 *
 * Frozen rules this module implements (01§07/§08, 02§10, 03§09/§12–15, issue
 * E05-02, scenarios AT-16/AT-17/AT-18):
 *
 *  - verification follows the chain "original user standard → corresponding
 *    artifact version → actual evidence → uncovered items → controller updates
 *    verification". It NEVER executes a test command, reads an arbitrary file or
 *    trusts an Agent's statement;
 *  - an Agent claiming "done" or a turn having ended is NOT a pass (AT-16). Only
 *    durable, version-matched evidence plus caller-supplied *results of checks
 *    that already ran* can cover an acceptance criterion;
 *  - evidence produced for a different artifact/task version is a MISMATCH, not
 *    a pass (AT-17). A source generation that moved on makes the evidence stale;
 *  - when the available facts cannot decide, the conclusion is `unknown` — BOOP
 *    never paints a fake green;
 *  - a user waiver ends verification as `waived`, which is never displayed as
 *    passed;
 *  - failures carry a stable fingerprint (no paths/time/sequence noise) and an
 *    attempt count; the same fingerprint reaching the limit stops further
 *    dispatch/self-heal and keeps the state (AT-18).
 *
 * The module is pure with respect to the ledger: it reads through injected ports
 * only, and `verify()` performs zero writes (audit rows belong to the calling
 * explicit actions, never to a read-only verification).
 */

import { createHash } from 'node:crypto'

/* ── contract constants ───────────────────────────────────────────────── */

export const VERIFY_SCHEMA_VERSION = 1 as const
export const VERIFY_ROW_ID = 'boop-verify'
export const VERIFY_REMOTE_NAMESPACE = 'boopVerify'
export const VERIFY_TOOL_NAME = 'boop_verify'
export const VERIFY_ENDPOINTS = ['boopVerify/verify', 'boopVerify/previewHeal', 'boopVerify/status'] as const
/** Same failure fingerprint may drive at most this many auto-repair attempts. */
export const DEFAULT_HEAL_ATTEMPT_LIMIT = 2
/** Bound on caller-supplied evidence refs / checks (a verification is bounded). */
export const VERIFY_EVIDENCE_LIMIT = 32
export const VERIFY_CHECK_LIMIT = 32

export type VerificationConclusion = 'passed' | 'failed' | 'partial' | 'unknown' | 'stale'
export type CriterionOutcome = 'passed' | 'failed' | 'uncovered' | 'unknown'
export type EvidenceRefKind = 'session' | 'fact' | 'claim'
export type RecommendedVerification = 'passed' | 'failed' | 'pending' | 'waived'
export type NextAction =
  | 'record-verification'
  | 'record-waived'
  | 'plan-repair'
  | 'stop-dispatch'
  | 'refresh-evidence'
  | 'collect-evidence'
  | 'define-criteria'

/* ── ports (all read-only) ────────────────────────────────────────────── */

export interface VerifyTaskRow {
  taskId: string
  /** Current task version. Evidence must be produced for exactly this version. */
  version: number
  lifecycle: string
  verification: string
  goal: string
  criteria: string[]
  exclusions: string[]
}

export interface VerifySnapshotRow {
  version: number
  goal: string
  criteria: string[]
  exclusions: string[]
}

export interface VerifyActionRow {
  actionId: string
  taskVersion: number
  state: string
  targetSessionId: string | null
  messageId: string | null
}

export interface VerifyEvidenceRow {
  factId: string
  factVersion: number
  useKind: 'answer' | 'plan' | 'dispatch' | 'verification'
  actionId: string | null
  sessionId: string | null
  seq: number | null
  sourceHash: string
  artifactRef: string | null
  /** Ledger drill-down address (`session:<id>#seq:<n>` / `fact:<id>@<v>`). */
  address: string
}

export interface VerifyTaskDetail {
  task: VerifyTaskRow
  snapshot: VerifySnapshotRow | null
  actions: VerifyActionRow[]
  evidence: VerifyEvidenceRow[]
}

export interface VerifyLedgerPort {
  /** Read-only task detail; `{available:false}` when the ledger cannot answer. */
  taskDetail(taskId: string): { available: boolean; reason: string | null; detail: VerifyTaskDetail | null }
  /** Current observed source generations (BOOP's own cursor plane), or null. */
  sourceGenerations(sessionIds: string[]): Record<string, string> | null
  /** Fact identity/version lookup for `fact:<id>@<v>` addresses, or null. */
  fact(factId: string): { factId: string; version: number; status: string; text: string } | null
}

export interface VerifyGatePort {
  writeMode(): { enabled: boolean; blockedByGates: string[] }
}

/** Attempt ledger for failure fingerprints (in-memory by default; injectable). */
export interface AttemptLedgerPort {
  peek(fingerprint: string): number
  record(fingerprint: string): number
  reset(fingerprint?: string): void
}

export class InMemoryAttemptLedger implements AttemptLedgerPort {
  private readonly counts = new Map<string, number>()

  peek(fingerprint: string): number {
    return this.counts.get(fingerprint) ?? 0
  }

  record(fingerprint: string): number {
    const next = this.peek(fingerprint) + 1
    this.counts.set(fingerprint, next)
    return next
  }

  reset(fingerprint?: string): void {
    if (fingerprint === undefined) this.counts.clear()
    else this.counts.delete(fingerprint)
  }

  /** Number of distinct fingerprints currently tracked. */
  size(): number {
    return this.counts.size
  }
}

/* ── request / result contracts ──────────────────────────────────────── */

export interface VerifyCheckInput {
  criterionIndex?: number
  /** Exact acceptance-criterion text alternative to the index. */
  criterion?: string
  /** The RESULT of a check that already ran elsewhere; BOOP never runs it. */
  state: 'passed' | 'failed' | 'unknown'
  detail?: string
  evidenceRefs?: string[]
}

export interface VerifyClaimInput {
  /** An Agent's own claim ("done", "tests pass"). Never counts as evidence. */
  text?: string
  kind?: 'agent-claim'
}

export interface VerifyRequest {
  taskId: string
  evidenceRefs?: string[]
  checks?: Array<VerifyCheckInput | string>
  /** A statement to explicitly classify as a non-verifiable Agent claim (AT-16). */
  claim?: VerifyClaimInput
}

export interface VerifyEvidenceFacts {
  ref: string
  kind: EvidenceRefKind
  /** Address resolved to a durable ledger row / fact? */
  resolved: boolean
  agentClaim: boolean
  useKind: string | null
  actionId: string | null
  sessionId: string | null
  seq: number | null
  /** Artifact/task version this evidence was produced for, when provable. */
  version: number | null
  versionMatchesTask: boolean | null
  /** Session source generation moved on / cannot be verified. */
  generationMoved: boolean
  generationVerified: boolean
  staleReason: string | null
  detail: string | null
}

export interface VerifyCriterionFacts {
  index: number
  text: string
  outcome: CriterionOutcome
  /** Exactly which evidence / check covered it (never an Agent claim alone). */
  coveredBy: string[]
  detail: string | null
}

export interface VerifyResultFacts {
  schemaVersion: 1
  product: 'BOOP'
  taskId: string
  generatedAt: string
  /** This engine never writes: the count is part of the contract. */
  ledgerWrites: 0
  readOnly: true
  available: boolean
  reason: string | null
  detail: string | null
  writeMode: { enabled: boolean; blockedByGates: string[] }
  task: {
    version: number
    lifecycle: string
    verification: string
    goal: string
  } | null
  conclusion: VerificationConclusion
  /** What the controller may store; never auto-applies a pass for unknown/stale. */
  recommendedVerification: RecommendedVerification
  recordedVerification: string | null
  criteria: VerifyCriterionFacts[]
  coverage: { total: number; passed: number; failed: number; uncovered: number; unknown: number }
  evidence: VerifyEvidenceFacts[]
  /** Counters that make the decision auditable without replaying raw text. */
  gates: {
    criteriaCovered: boolean
    evidenceVersionMatched: boolean
    evidenceCurrent: boolean
    noAgentClaimOnly: boolean
  }
  claimObserved: boolean
  waived: boolean
  uncovered: number[]
  gaps: string[]
  fingerprint: string
  attempt: number
  attemptLimit: number
  limitReached: boolean
  halted: boolean
  nextAction: NextAction
  limitations: string[]
}

/* ── pure helpers ────────────────────────────────────────────────────── */

export interface ParsedEvidenceRef {
  raw: string
  kind: EvidenceRefKind
  sessionId?: string
  seq?: number
  factId?: string
  version?: number
}

/**
 * Parse the frozen evidence address forms.
 *
 * Accepted: `session:<sessionId>#seq:<n>`, `fact:<factId>@<version>`.
 * A free-form statement is classified as an Agent claim, never as evidence.
 */
export function parseEvidenceRef(ref: string): ParsedEvidenceRef | null {
  const trimmed = ref.trim()
  if (trimmed === '') return null
  const session = /^session:(.+?)#seq:(\d+)$/u.exec(trimmed)
  if (session) return { raw: trimmed, kind: 'session', sessionId: session[1], seq: Number(session[2]) }
  const fact = /^fact:(.+?)@(\d+)$/u.exec(trimmed)
  if (fact) return { raw: trimmed, kind: 'fact', factId: fact[1], version: Number(fact[2]) }
  if (/(?:done|completed|finished)\\b|完成了|已完成|做完了|搞定了|已经完成/u.test(trimmed) || trimmed.startsWith('claim:')) {
    return { raw: trimmed, kind: 'claim' }
  }
  return null
}

/** Stable failure fingerprint: only ids/codes/indices, no paths, time or seq. */
export function fingerprintOf(input: {
  taskId: string
  conclusion: VerificationConclusion
  failedCriteria: number[]
  gaps: string[]
}): string {
  const parts = [
    'v1',
    `task:${input.taskId}`,
    `conclusion:${input.conclusion}`,
    `failed:${[...input.failedCriteria].sort((a, b) => a - b).join(',')}`,
    `gaps:${[...new Set(input.gaps)].sort().join(',')}`,
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)
}

/** Normalise a check given as an object or a compact `index:state[:detail]` string. */
export function normalizeCheck(input: VerifyCheckInput | string): VerifyCheckInput | null {
  if (typeof input === 'string') {
    const parts = input.split(':')
    if (parts.length < 2) return null
    const index = Number(parts[0])
    const state = parts[1]?.trim()
    if (!Number.isInteger(index) || index < 0) return null
    if (state !== 'passed' && state !== 'failed' && state !== 'unknown') return null
    return { criterionIndex: index, state, ...(parts.length > 2 ? { detail: parts.slice(2).join(':') } : {}) }
  }
  if (!input || typeof input !== 'object') return null
  const state = input.state
  if (state !== 'passed' && state !== 'failed' && state !== 'unknown') return null
  if (input.criterionIndex !== undefined && (!Number.isInteger(input.criterionIndex) || input.criterionIndex < 0)) return null
  return {
    ...(input.criterionIndex === undefined ? {} : { criterionIndex: input.criterionIndex }),
    ...(typeof input.criterion === 'string' && input.criterion.trim() !== '' ? { criterion: input.criterion.trim() } : {}),
    state,
    ...(typeof input.detail === 'string' && input.detail !== '' ? { detail: input.detail } : {}),
    ...(Array.isArray(input.evidenceRefs) ? { evidenceRefs: input.evidenceRefs.filter((ref) => typeof ref === 'string') } : {}),
  }
}

/* ── the verifier ────────────────────────────────────────────────────── */

export interface EvidenceVerifierOptions {
  ledger: VerifyLedgerPort
  gate: VerifyGatePort
  attempts?: AttemptLedgerPort
  attemptLimit?: number
  now?: () => number
}

interface CollectedEvidence {
  facts: VerifyEvidenceFacts
  /** action state for dispatch/verification rows; null when unknown */
  actionState: string | null
}

export class EvidenceVerifier {
  private readonly ledger: VerifyLedgerPort
  private readonly gate: VerifyGatePort
  private readonly attempts: AttemptLedgerPort
  private readonly attemptLimit: number
  private readonly now: () => number

  constructor(options: EvidenceVerifierOptions) {
    this.ledger = options.ledger
    this.gate = options.gate
    this.attempts = options.attempts ?? new InMemoryAttemptLedger()
    this.attemptLimit = Math.max(1, options.attemptLimit ?? DEFAULT_HEAL_ATTEMPT_LIMIT)
    this.now = options.now ?? (() => Date.now())
  }

  /** Read-only verification of one task against supplied evidence/check results. */
  verify(input: VerifyRequest): VerifyResultFacts {
    const writeMode = this.safeWriteMode()
    const base = (conclusion: VerificationConclusion, patch: Partial<VerifyResultFacts> = {}): VerifyResultFacts => ({
      schemaVersion: VERIFY_SCHEMA_VERSION,
      product: 'BOOP',
      taskId: typeof input?.taskId === 'string' ? input.taskId : '',
      generatedAt: new Date(this.now()).toISOString(),
      ledgerWrites: 0,
      readOnly: true,
      available: true,
      reason: null,
      detail: null,
      writeMode,
      task: null,
      conclusion,
      recommendedVerification: conclusion === 'failed' ? 'failed' : 'pending',
      recordedVerification: null,
      criteria: [],
      coverage: { total: 0, passed: 0, failed: 0, uncovered: 0, unknown: 0 },
      evidence: [],
      gates: { criteriaCovered: false, evidenceVersionMatched: false, evidenceCurrent: false, noAgentClaimOnly: false },
      claimObserved: false,
      waived: false,
      uncovered: [],
      gaps: [],
      fingerprint: '',
      attempt: 0,
      attemptLimit: this.attemptLimit,
      limitReached: false,
      halted: false,
      nextAction: 'collect-evidence',
      limitations: [
        'verification only reads the ledger; it never runs a test command and never reads an arbitrary file',
        'another model review is not an independent audit; BOOP only reports the evidence it can prove',
        'an Agent claim / turn completion is never acceptance evidence (AT-16)',
      ],
      ...patch,
    })

    const taskId = typeof input?.taskId === 'string' ? input.taskId.trim() : ''
    if (taskId === '') {
      return base('unknown', { reason: 'INVALID_REQUEST', detail: 'taskId is required', nextAction: 'collect-evidence' })
    }

    const detail = this.safeTaskDetail(taskId)
    if (detail === null || detail.available !== true) {
      return base('unknown', {
        available: false,
        reason: detail?.reason ?? 'LEDGER_UNAVAILABLE',
        detail: detail?.detail ?? 'the BOOP ledger cannot answer this verification right now',
        nextAction: 'collect-evidence',
      })
    }
    if (detail.detail === null) {
      return base('unknown', {
        reason: 'TASK_NOT_FOUND',
        detail: `task ${JSON.stringify(taskId)} is not in this data scope; BOOP never verifies another domain's task`,
        nextAction: 'collect-evidence',
      })
    }
    const found = detail.detail
    const task = found.task
    const criteria = this.criteriaOf(found)
    const recorded = task.verification
    const waived = recorded === 'waived'

    /* ── evidence collection (durable rows + caller refs + explicit claim) ─ */
    const evidenceRefs = Array.isArray(input.evidenceRefs)
      ? input.evidenceRefs.filter((ref): ref is string => typeof ref === 'string').slice(0, VERIFY_EVIDENCE_LIMIT)
      : []
    const claimText =
      input.claim && typeof input.claim === 'object' && typeof input.claim.text === 'string' ? input.claim.text : null
    const claimRefs = claimText !== null ? [claimText] : []
    const collected = this.collectEvidence(found, task, evidenceRefs, claimRefs)
    const claimObserved = collected.some((entry) => entry.facts.agentClaim) || claimText !== null

    /* ── criterion evaluation from checks (results that already ran) ─────── */
    const rawChecks = Array.isArray(input.checks) ? input.checks.slice(0, VERIFY_CHECK_LIMIT) : []
    const checks = rawChecks.map(normalizeCheck).filter((check): check is VerifyCheckInput => check !== null)
    const gaps: string[] = []
    if (rawChecks.length !== checks.length) gaps.push('CHECK_INPUT_INVALID')
    const criterionFacts: VerifyCriterionFacts[] = criteria.map((text, index) => ({
      index,
      text,
      outcome: 'uncovered',
      coveredBy: [],
      detail: null,
    }))
    for (const check of checks) {
      let index = check.criterionIndex ?? -1
      if (index < 0 && check.criterion !== undefined) index = criteria.indexOf(check.criterion)
      if (index < 0 || index >= criteria.length) {
        gaps.push('CHECK_CRITERION_UNKNOWN')
        continue
      }
      const criterion = criterionFacts[index]
      if (criterion.outcome === 'failed') continue
      criterion.outcome = check.state
      criterion.coveredBy = [...new Set([...criterion.coveredBy, ...(check.evidenceRefs ?? []), ...(check.detail === undefined ? [] : [check.detail])])]
      if (check.state === 'unknown') criterion.detail = check.detail ?? 'the check itself could not decide'
    }

    const coverage = {
      total: criteria.length,
      passed: criterionFacts.filter((entry) => entry.outcome === 'passed').length,
      failed: criterionFacts.filter((entry) => entry.outcome === 'failed').length,
      uncovered: criterionFacts.filter((entry) => entry.outcome === 'uncovered').length,
      unknown: criterionFacts.filter((entry) => entry.outcome === 'unknown').length,
    }
    const uncovered = criterionFacts.filter((entry) => entry.outcome === 'uncovered').map((entry) => entry.index)

    /* ── evidence admissibility gates (AT-16/AT-17) ─────────────────────── */
    const verifiable = collected.filter((entry) => !entry.facts.agentClaim)
    const staleEvidence = verifiable.filter((entry) => entry.facts.staleReason !== null)
    const versionMatched = verifiable.filter((entry) => entry.facts.versionMatchesTask === true)
    const versionUnproven = verifiable.filter((entry) => entry.facts.versionMatchesTask === null)
    const currentEvidence = verifiable.filter((entry) => entry.facts.generationVerified)
    const unusableAction = verifiable.filter(
      (entry) => entry.actionState !== null && ['outcome_unknown', 'rejected', 'stopped'].includes(entry.actionState),
    )
    const durableEvidence = verifiable.filter((entry) => entry.facts.resolved)
    if (versionUnproven.length > 0) gaps.push('EVIDENCE_VERSION_UNPROVEN')
    if (durableEvidence.filter((entry) => !entry.facts.generationVerified).length > 0) gaps.push('EVIDENCE_SOURCE_UNVERIFIED')
    if (unusableAction.length > 0) gaps.push('EVIDENCE_OUTCOME_UNKNOWN')
    if (claimObserved && verifiable.length === 0) gaps.push('AGENT_CLAIM_ONLY')
    if (criteria.length === 0) gaps.push('NO_ACCEPTANCE_CRITERIA')
    if (verifiable.length === 0 && claimObserved) gaps.push('NO_DURABLE_EVIDENCE')

    const gates = {
      criteriaCovered: criteria.length > 0 && uncovered.length === 0 && coverage.unknown === 0,
      evidenceVersionMatched: verifiable.length > 0 && versionMatched.length === verifiable.length && staleEvidence.length === 0,
      evidenceCurrent: durableEvidence.length > 0 && currentEvidence.length === durableEvidence.length,
      noAgentClaimOnly: !(claimObserved && verifiable.length === 0),
    }

    /* ── conclusion (conservative precedence: failed > stale > ... ) ────── */
    let conclusion: VerificationConclusion = 'unknown'
    let reason: string | null = null
    if (waived) {
      conclusion = 'unknown'
      reason = 'VERIFICATION_WAIVED'
    } else if (recorded === 'not_requested') {
      conclusion = 'unknown'
      reason = 'VERIFICATION_NOT_REQUESTED'
    } else if (task.lifecycle === 'cancelled') {
      conclusion = 'unknown'
      reason = 'TASK_CANCELLED'
    } else if (task.lifecycle === 'draft') {
      conclusion = 'unknown'
      reason = 'TASK_NOT_ACTIVE'
    } else if (coverage.failed > 0) {
      conclusion = 'failed'
      reason = 'CHECK_FAILED'
    } else if (staleEvidence.length > 0) {
      conclusion = 'stale'
      reason = staleEvidence[0].facts.staleReason ?? 'EVIDENCE_STALE'
    } else if (criteria.length === 0) {
      conclusion = 'unknown'
      reason = 'NO_ACCEPTANCE_CRITERIA'
    } else if (
      coverage.passed === coverage.total &&
      gates.evidenceVersionMatched &&
      gates.evidenceCurrent &&
      unusableAction.length === 0
    ) {
      // An Agent claim next to real evidence neither helps nor blocks: it is
      // simply not counted (AT-16).
      conclusion = 'passed'
    } else if (coverage.passed > 0) {
      conclusion = 'partial'
      reason = 'CRITERIA_PARTIALLY_COVERED'
    } else {
      conclusion = 'unknown'
      reason = verifiable.length === 0 ? 'NO_DURABLE_EVIDENCE' : 'NO_CRITERIA_COVERAGE'
    }

    const failedCriteria = criterionFacts.filter((entry) => entry.outcome === 'failed').map((entry) => entry.index)
    const fingerprint = fingerprintOf({ taskId, conclusion, failedCriteria, gaps })
    let attempt = this.attempts.peek(fingerprint)
    if (conclusion === 'failed') attempt = this.attempts.record(fingerprint)
    const limitReached = conclusion === 'failed' && attempt >= this.attemptLimit

    const recommendedVerification: RecommendedVerification =
      conclusion === 'passed' ? 'passed' : conclusion === 'failed' ? 'failed' : waived ? 'waived' : 'pending'
    const nextAction: NextAction =
      conclusion === 'passed'
        ? 'record-verification'
        : waived
          ? 'record-waived'
          : conclusion === 'failed'
            ? limitReached
              ? 'stop-dispatch'
              : 'plan-repair'
            : conclusion === 'stale'
              ? 'refresh-evidence'
              : criteria.length === 0
                ? 'define-criteria'
                : 'collect-evidence'

    return base(conclusion, {
      reason,
      task: { version: task.version, lifecycle: task.lifecycle, verification: recorded, goal: task.goal },
      recommendedVerification,
      recordedVerification: recorded,
      criteria: criterionFacts,
      coverage,
      evidence: collected.map((entry) => entry.facts),
      gates,
      claimObserved,
      waived,
      uncovered,
      gaps: [...new Set(gaps)],
      fingerprint,
      attempt,
      limitReached,
      halted: limitReached,
      nextAction,
      detail: [
        `task v${task.version}; evidence ${verifiable.length} row(s); criteria covered ${coverage.passed + coverage.failed}/${coverage.total}`,
        staleEvidence.length > 0 ? `stale evidence: ${staleEvidence.map((entry) => entry.facts.ref).join(', ')}` : null,
        limitReached ? `fingerprint attempt limit ${this.attemptLimit} reached; stop further dispatch/self-heal` : null,
      ]
        .filter((part): part is string => part !== null)
        .join('; '),
    })
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  private safeWriteMode(): { enabled: boolean; blockedByGates: string[] } {
    try {
      const status = this.gate.writeMode()
      return { enabled: status.enabled === true, blockedByGates: Array.isArray(status.blockedByGates) ? [...status.blockedByGates] : [] }
    } catch {
      return { enabled: false, blockedByGates: [] }
    }
  }

  private safeTaskDetail(taskId: string): { available: boolean; reason: string | null; detail: VerifyTaskDetail | null } | null {
    try {
      return this.ledger.taskDetail(taskId)
    } catch (error) {
      return { available: false, reason: 'LEDGER_READ_FAILED', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  private criteriaOf(detail: VerifyTaskDetail): string[] {
    const fromSnapshot = detail.snapshot?.criteria
    const list = Array.isArray(fromSnapshot) && fromSnapshot.length > 0 ? fromSnapshot : detail.task.criteria
    return (Array.isArray(list) ? list : []).map((entry) => String(entry)).filter((entry) => entry.trim() !== '')
  }

  private collectEvidence(
    detail: VerifyTaskDetail,
    task: VerifyTaskRow,
    callerRefs: string[],
    claimRefs: string[],
  ): CollectedEvidence[] {
    const actionById = new Map(detail.actions.map((action) => [action.actionId, action]))
    const generations = (() => {
      const sessionIds = [...new Set(detail.evidence.map((row) => row.sessionId).filter((id): id is string => id !== null))]
      if (sessionIds.length === 0) return {}
      try {
        return this.ledger.sourceGenerations(sessionIds) ?? {}
      } catch {
        return {}
      }
    })()
    const seen = new Set<string>()
    const out: CollectedEvidence[] = []

    const push = (entry: CollectedEvidence): void => {
      if (seen.has(entry.facts.ref)) return
      seen.add(entry.facts.ref)
      out.push(entry)
    }

    /* durable ledger evidence for this task (fact_consumption ⋈ evidence) */
    for (const row of detail.evidence) {
      push(this.admitEvidenceRow(row, task, actionById, generations, null))
    }

    /* caller-supplied addresses: resolved against the ledger, never trusted raw */
    for (const ref of callerRefs) {
      const parsed = parseEvidenceRef(ref)
      if (parsed === null) {
        push({
          facts: {
            ref,
            kind: 'claim',
            resolved: false,
            agentClaim: false,
            useKind: null,
            actionId: null,
            sessionId: null,
            seq: null,
            version: null,
            versionMatchesTask: null,
            generationMoved: false,
            generationVerified: false,
            staleReason: null,
            detail: 'unrecognized evidence address; accepted forms are session:<id>#seq:<n> and fact:<id>@<version>',
          },
          actionState: null,
        })
        continue
      }
      if (parsed.kind === 'claim') {
        push({
          facts: {
            ref,
            kind: 'claim',
            resolved: false,
            agentClaim: true,
            useKind: null,
            actionId: null,
            sessionId: null,
            seq: null,
            version: null,
            versionMatchesTask: null,
            generationMoved: false,
            generationVerified: false,
            staleReason: null,
            detail: 'an Agent statement is not acceptance evidence (AT-16)',
          },
          actionState: null,
        })
        continue
      }
      if (parsed.kind === 'session') {
        const row = detail.evidence.find((entry) => entry.sessionId === parsed.sessionId && entry.seq === parsed.seq)
        if (row) {
          push(this.admitEvidenceRow(row, task, actionById, generations, null))
        } else {
          push({
            facts: {
              ref,
              kind: 'session',
              resolved: false,
              agentClaim: false,
              useKind: null,
              actionId: null,
              sessionId: parsed.sessionId ?? null,
              seq: parsed.seq ?? null,
              version: null,
              versionMatchesTask: null,
              generationMoved: false,
              generationVerified: false,
              staleReason: null,
              detail: 'this session/seq is not recorded as evidence for the task',
            },
            actionState: null,
          })
        }
        continue
      }
      const fact = (() => {
        try {
          return this.ledger.fact(parsed.factId ?? '')
        } catch {
          return null
        }
      })()
      const addressVersion = parsed.version ?? null
      if (fact === null) {
        push({
          facts: {
            ref,
            kind: 'fact',
            resolved: false,
            agentClaim: false,
            useKind: null,
            actionId: null,
            sessionId: null,
            seq: null,
            version: addressVersion,
            versionMatchesTask: null,
            generationMoved: false,
            generationVerified: false,
            staleReason: null,
            detail: 'fact not found in this data domain',
          },
          actionState: null,
        })
        continue
      }
      const factVersion = fact.version
      const versionMatchesTask = addressVersion === null ? null : addressVersion === task.version
      const staleReason =
        addressVersion !== null && addressVersion !== task.version
          ? `EVIDENCE_VERSION_MISMATCH:address v${addressVersion} != task v${task.version}`
          : factVersion !== addressVersion && addressVersion !== null
            ? `EVIDENCE_SUPERSEDED:fact now v${factVersion}`
            : null
      push({
        facts: {
          ref,
          kind: 'fact',
          resolved: true,
          agentClaim: false,
          useKind: null,
          actionId: null,
          sessionId: null,
          seq: null,
          version: addressVersion ?? factVersion,
          versionMatchesTask,
          generationMoved: false,
          generationVerified: false,
          staleReason,
          detail: `fact status ${fact.status}`,
        },
        actionState: null,
      })
    }

    /* explicit Agent claim input */
    for (const claim of claimRefs) {
      push({
        facts: {
          ref: `claim:${claim.slice(0, 120)}`,
          kind: 'claim',
          resolved: false,
          agentClaim: true,
          useKind: null,
          actionId: null,
          sessionId: null,
          seq: null,
          version: null,
          versionMatchesTask: null,
          generationMoved: false,
          generationVerified: false,
          staleReason: null,
          detail: 'explicitly classified as an Agent claim, never evidence (AT-16)',
        },
        actionState: null,
      })
    }
    return out
  }

  private admitEvidenceRow(
    row: VerifyEvidenceRow,
    task: VerifyTaskRow,
    actionById: Map<string, VerifyActionRow>,
    generations: Record<string, string>,
    detailOverride: string | null,
  ): CollectedEvidence {
    const action = row.actionId === null ? null : actionById.get(row.actionId) ?? null
    const generation = row.sourceHash.includes('#') ? row.sourceHash.split('#')[0] : null
    const currentGeneration = row.sessionId === null ? undefined : generations[row.sessionId]
    const generationMoved =
      generation !== null && currentGeneration !== undefined && currentGeneration !== generation
    const generationVerified = generation !== null && currentGeneration !== undefined && currentGeneration === generation
    const version = action === null ? null : action.taskVersion
    const versionMatchesTask = version === null ? null : version === task.version
    const staleReason =
      generationMoved
        ? 'EVIDENCE_GENERATION_MOVED:the source generation changed after this evidence was produced'
        : version !== null && version !== task.version
          ? `EVIDENCE_VERSION_MISMATCH:evidence v${version} != task v${task.version}`
          : null
    return {
      facts: {
        ref: row.address,
        kind: row.sessionId !== null && row.seq !== null ? 'session' : 'fact',
        resolved: true,
        agentClaim: false,
        useKind: row.useKind,
        actionId: row.actionId,
        sessionId: row.sessionId,
        seq: row.seq,
        version,
        versionMatchesTask,
        generationMoved,
        generationVerified,
        staleReason,
        detail:
          detailOverride ??
          `durable ${row.useKind} evidence${action === null ? '' : ` (action ${action.state})`}`,
      },
      actionState: action?.state ?? null,
    }
  }
}

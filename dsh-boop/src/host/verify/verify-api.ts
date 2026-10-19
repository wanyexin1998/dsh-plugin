/**
 * BOOP verification host row `boop-verify` (E05-02, host half).
 *
 * An unambiguous Cordis function plugin (`name` / `inject` / `apply`) mounted
 * from `cordis.patch.yml` as `boop-verify`, so the evidence-verification engine
 * and the limited self-heal preview can be composed, disabled or tested
 * independently of the other BOOP rows.
 *
 * It registers the `boopVerify` Typert Remote service over the framework-free
 * cores in `verifier.ts` / `self-heal.ts`:
 *
 *  - `verify`      — READ-ONLY: durable ledger evidence + caller-supplied check
 *                    RESULTS (BOOP never runs a test command) → passed / failed
 *                    / partial / unknown / stale, per-criterion conclusions and
 *                    gaps. Zero ledger writes;
 *  - `previewHeal` — READ-ONLY verify + a bounded repair preview with a stable
 *                    failure fingerprint and attempt limit. It never executes and
 *                    never dispatches; while write mode is closed the value says
 *                    `CAPABILITY_UNAVAILABLE` / `executed:false`, and the request
 *                    is audited. Routing a real repair remains the dispatcher's
 *                    single write path (never bypassed here);
 *  - `status`      — row/verifier facts: write mode, gates, attempt ledger,
 *                    whether the model-facing `boop_verify` tool is registered.
 *
 * Wire shape (rc.2.1 SRC convention): every method takes ONE `request` object;
 * responses are SINGLE-LAYER fact objects inside `result.value`. Business
 * refusals stay in the value (`ok:false` + `code`), never as transport errors.
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { remote } from '../remote.ts'
import {
  DEFAULT_HEAL_ATTEMPT_LIMIT,
  VERIFY_ENDPOINTS,
  VERIFY_REMOTE_NAMESPACE,
  VERIFY_ROW_ID,
  VERIFY_SCHEMA_VERSION,
  VERIFY_TOOL_NAME,
  EvidenceVerifier,
  InMemoryAttemptLedger,
  normalizeCheck,
  type VerifyCheckInput,
  type VerifyEvidenceRow,
  type VerifyGatePort,
  type VerifyLedgerPort,
  type VerifyRequest,
  type VerifyResultFacts,
  type VerifyTaskDetail,
} from './verifier.ts'
import {
  planSelfHeal,
  renderSelfHealPlan,
  type SelfHealPlanFacts,
} from './self-heal.ts'

export const name = 'boop-verify'

/** `boop` carries the ledger/gate/write-mode; the gateway routes Remote methods. */
export const inject = ['boop', 'typertGateway']

export interface BoopVerifyConfig {
  /** Set false only in isolated diagnostics; the shipped default registers the row. */
  enabled?: boolean
  /** Max auto-repair attempts per failure fingerprint (frozen default 2). */
  maxAttempts?: number
}

/* ── host helpers ─────────────────────────────────────────────────────── */

function storageOf(ctx: any): any {
  try {
    return ctx.boop?.storage?.() ?? null
  } catch {
    return null
  }
}

function scopeIdOf(ctx: any): string | null {
  try {
    const id = storageOf(ctx)?.identity?.scopeId
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

function writeModeOf(ctx: any): { enabled: boolean; blockedByGates: string[] } {
  try {
    const status = ctx.boop?.writeMode?.()
    if (status && typeof status === 'object') {
      return {
        enabled: status.enabled === true,
        blockedByGates: Array.isArray(status.blockedByGates) ? status.blockedByGates.map(String) : [],
      }
    }
    return { enabled: ctx.boop?.isWriteModeEnabled?.() === true, blockedByGates: [] }
  } catch {
    return { enabled: false, blockedByGates: [] }
  }
}

function gatesOf(ctx: any): Record<string, string> {
  try {
    const gates = ctx.boop?.state?.()?.gates
    return gates && typeof gates === 'object' ? { ...gates } : {}
  } catch {
    return {}
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : []
}

function snapshotOf(snapshot: unknown): VerifyTaskDetail['snapshot'] {
  if (!snapshot || typeof snapshot !== 'object') return null
  const record = snapshot as Record<string, unknown>
  const version = Number(record.version)
  return {
    version: Number.isFinite(version) && version > 0 ? version : 0,
    goal: typeof record.goal === 'string' ? record.goal : '',
    criteria: asStringArray(record.criteria),
    exclusions: asStringArray(record.exclusions),
  }
}

/* ── read-only ledger port over the real BOOP ledger ─────────────────── */

function ledgerPortOf(ctx: any): VerifyLedgerPort {
  return {
    taskDetail(taskId: string): { available: boolean; reason: string | null; detail: VerifyTaskDetail | null } {
      try {
        const storage = storageOf(ctx)
        const scopeId = scopeIdOf(ctx)
        if (!storage?.repo || scopeId === null || typeof storage.repo.taskDetail !== 'function') {
          return { available: false, reason: 'LEDGER_UNAVAILABLE', detail: 'BOOP ledger is unavailable; task facts cannot be read' }
        }
        const row = storage.repo.taskDetail(scopeId, taskId)
        if (row === null) return { available: true, reason: null, detail: null }
        const detail: VerifyTaskDetail = {
          task: {
            taskId: String(row.task.id),
            version: Number(row.task.version),
            lifecycle: String(row.task.lifecycle),
            verification: String(row.task.verification),
            goal: String(row.task.goal),
            criteria: asStringArray(row.task.criteria),
            exclusions: asStringArray(row.task.exclusions),
          },
          snapshot: row.latestSnapshot === null ? null : snapshotOf(row.latestSnapshot.snapshot),
          actions: (row.actions as Array<Record<string, unknown>>).map((action) => ({
            actionId: String(action.id ?? ''),
            taskVersion: Number(action.taskVersion ?? 0),
            state: String(action.state ?? ''),
            targetSessionId: action.targetSessionId === null ? null : String(action.targetSessionId ?? ''),
            messageId: action.messageId === null ? null : String(action.messageId ?? ''),
          })),
          evidence: (row.evidence as Array<Record<string, unknown>>).map((entry) => ({
            factId: String(entry.factId ?? ''),
            factVersion: Number(entry.factVersion ?? 0),
            useKind: String(entry.useKind ?? 'answer') as VerifyEvidenceRow['useKind'],
            actionId: entry.actionId === null ? null : String(entry.actionId ?? ''),
            sessionId: entry.sessionId === null ? null : String(entry.sessionId ?? ''),
            seq: entry.seq === null ? null : Number(entry.seq),
            sourceHash: String(entry.sourceHash ?? ''),
            artifactRef: entry.artifactRef === null ? null : String(entry.artifactRef ?? ''),
            // The repository row carries the raw columns; the drill-down address
            // is derived here exactly like the Taskboard projection does.
            address:
              entry.sessionId !== null && entry.seq !== null
                ? `session:${String(entry.sessionId)}#seq:${Number(entry.seq)}`
                : `fact:${String(entry.factId)}@${Number(entry.factVersion)}`,
          })),
        }
        return { available: true, reason: null, detail }
      } catch (error) {
        return {
          available: false,
          reason: 'LEDGER_READ_FAILED',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    },
    sourceGenerations(sessionIds: string[]): Record<string, string> | null {
      try {
        const storage = storageOf(ctx)
        const scopeId = scopeIdOf(ctx)
        if (!storage?.db?.db || scopeId === null || sessionIds.length === 0) return null
        const rows = storage.db.db
          .prepare('SELECT session_id, source_generation FROM source_cursor WHERE scope_id = ?')
          .all(scopeId) as Array<{ session_id: string; source_generation: string }>
        const wanted = new Set(sessionIds)
        const map: Record<string, string> = {}
        for (const row of rows) {
          if (wanted.has(String(row.session_id))) map[String(row.session_id)] = String(row.source_generation)
        }
        return map
      } catch {
        return null
      }
    },
    fact(factId: string) {
      try {
        const storage = storageOf(ctx)
        const scopeId = scopeIdOf(ctx)
        if (!storage?.db?.db || scopeId === null) return null
        const row = storage.db.db
          .prepare('SELECT id, version, status, text FROM fact WHERE scope_id = ? AND id = ?')
          .get(scopeId, factId) as { id: string; version: number; status: string; text: string } | undefined
        return row === undefined ? null : { factId: String(row.id), version: Number(row.version), status: String(row.status), text: String(row.text) }
      } catch {
        return null
      }
    },
  }
}

function gatePortOf(ctx: any): VerifyGatePort {
  return { writeMode: () => writeModeOf(ctx) }
}

/* ── shared runtime (row + model-facing tool use the same attempt ledger) ─ */

export interface VerifyRuntime {
  verifier: EvidenceVerifier
  attempts: InMemoryAttemptLedger
  config: BoopVerifyConfig
}

/** Build one runtime (verifier + attempt ledger) over the real host ports. */
export function createVerifyRuntime(ctx: any, config: BoopVerifyConfig = {}): VerifyRuntime {
  const attempts = new InMemoryAttemptLedger()
  return {
    attempts,
    config,
    verifier: new EvidenceVerifier({
      ledger: ledgerPortOf(ctx),
      gate: gatePortOf(ctx),
      attempts,
      attemptLimit: Math.max(1, config.maxAttempts ?? DEFAULT_HEAL_ATTEMPT_LIMIT),
    }),
  }
}

/** Normalise a wire/tool request without trusting its shape. */
export function normalizeVerifyRequest(input: unknown): VerifyRequest | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const nested = record.request && typeof record.request === 'object' ? (record.request as Record<string, unknown>) : record
  const taskId = typeof nested.taskId === 'string' ? nested.taskId.trim() : ''
  if (taskId === '') return null
  const evidenceRefs = Array.isArray(nested.evidenceRefs)
    ? nested.evidenceRefs.filter((ref): ref is string => typeof ref === 'string')
    : undefined
  const checks = Array.isArray(nested.checks)
    ? (nested.checks as Array<VerifyCheckInput | string>).filter((check) => normalizeCheck(check) !== null)
    : undefined
  const claim =
    nested.claim && typeof nested.claim === 'object'
      ? { text: String((nested.claim as Record<string, unknown>).text ?? '') }
      : undefined
  return {
    taskId,
    ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
    ...(checks === undefined ? {} : { checks }),
    ...(claim === undefined ? {} : { claim }),
  }
}

/**
 * Model-facing `boop_verify` execution helper (used by the `boop-tools` row).
 *
 * Read-only. When the `boop-verify` row is mounted it reuses that row's verifier
 * through `boopVerifyRules`, so the fingerprint attempt ledger is consistent
 * between the API and the tool. A composition without the row still verifies,
 * but the attempt ledger is then per-call (reported in the tool value).
 */
export function runVerifyTool(ctx: any, args: unknown): VerifyResultFacts {
  const request = normalizeVerifyRequest(args)
  try {
    const rules = ctx.reflect?.get?.('boopVerifyRules', false) ?? null
    if (rules && typeof rules.verify === 'function') {
      return request === null ? rules.verify({ taskId: '' }) : rules.verify(request)
    }
  } catch {
    /* fall through to a local runtime */
  }
  const runtime = createVerifyRuntime(ctx)
  return request === null ? runtime.verifier.verify({ taskId: '' }) : runtime.verifier.verify(request)
}

/* ── Remote service (the UI/IM transport plane) ───────────────────────── */

export interface PreviewHealResponse extends SelfHealPlanFacts {
  available: boolean
  ok: boolean
  /** Business refusal code; `CAPABILITY_UNAVAILABLE` while write mode is closed. */
  code: SelfHealPlanFacts['code']
  verification: {
    conclusion: VerifyResultFacts['conclusion']
    recommendedVerification: VerifyResultFacts['recommendedVerification']
    fingerprint: string
    attempt: number
    limitReached: boolean
  }
  audit: { sink: string; persisted: boolean; kind: string } | null
  rendered: string
}

export interface VerifyStatusResponse {
  schemaVersion: 1
  product: 'BOOP'
  row: string
  remoteService: string
  at: string
  writeMode: { enabled: boolean; blockedByGates: string[] }
  gates: Record<string, string>
  ledger: { available: boolean; note: string }
  verifier: {
    attemptLimit: number
    attemptsRecorded: number
    modelCalls: 0
    executesCommands: false
    readsArbitraryFiles: false
  }
  tool: { name: string; registered: boolean }
  /** The other read-only model-facing tools this row's host half backs. */
  relatedTools: { boop_catalog: boolean }
  endpoints: readonly string[]
}

function toolRegistered(ctx: any, name: string = VERIFY_TOOL_NAME): boolean {
  try {
    const tools = ctx.reflect?.get?.('tools', false)
    return tools !== null && tools !== undefined && typeof tools.get === 'function' && tools.get(name) !== undefined
  } catch {
    return false
  }
}

class BoopVerifyApi extends TypertRemoteService {
  private readonly ctx: any
  private readonly runtime: VerifyRuntime
  private readonly audit: VerifyAuditSink

  constructor(ctx: any, runtime: VerifyRuntime) {
    super(ctx, VERIFY_REMOTE_NAMESPACE, { namespace: VERIFY_REMOTE_NAMESPACE })
    this.ctx = ctx
    this.runtime = runtime
    this.audit = new VerifyAuditSink(ctx)
  }

  /** Read-only verification. Never writes the ledger, never runs a command. */
  verify(request?: unknown): VerifyResultFacts {
    const normalized = normalizeVerifyRequest(request)
    if (normalized === null) {
      return this.runtime.verifier.verify({ taskId: '' })
    }
    return this.runtime.verifier.verify(normalized)
  }

  /**
   * Read-only verification + limited repair PREVIEW (never executes).
   * While write mode is closed the value is a `CAPABILITY_UNAVAILABLE` refusal
   * that still carries the honest plan, and the request is audited.
   */
  previewHeal(request?: unknown): PreviewHealResponse {
    const normalized = normalizeVerifyRequest(request)
    const verification =
      normalized === null
        ? this.runtime.verifier.verify({ taskId: '' })
        : this.runtime.verifier.verify(normalized)
    const writeMode = writeModeOf(this.ctx)
    const plan = planSelfHeal({ verification, writeMode, maxAttempts: this.runtime.config.maxAttempts })
    const receipt = this.audit.record({
      kind: 'verify/preview-heal',
      taskId: verification.taskId,
      detail:
        `conclusion=${verification.conclusion} code=${plan.code ?? 'none'} candidates=${plan.candidates.length} ` +
        `fingerprint=${verification.fingerprint} attempt=${verification.attempt} executed=false`,
    })
    const ok = plan.ok && this.runtime.config.enabled !== false
    return {
      ...plan,
      ok,
      code: ok ? null : (plan.code ?? 'CAPABILITY_UNAVAILABLE'),
      verification: {
        conclusion: verification.conclusion,
        recommendedVerification: verification.recommendedVerification,
        fingerprint: verification.fingerprint,
        attempt: verification.attempt,
        limitReached: verification.limitReached,
      },
      audit: receipt,
      rendered: renderSelfHealPlan(plan),
    }
  }

  /** Row/verifier facts. */
  status(_request?: unknown): VerifyStatusResponse {
    const storage = storageOf(this.ctx)
    return {
      schemaVersion: VERIFY_SCHEMA_VERSION,
      product: 'BOOP',
      row: VERIFY_ROW_ID,
      remoteService: VERIFY_REMOTE_NAMESPACE,
      at: new Date().toISOString(),
      writeMode: writeModeOf(this.ctx),
      gates: gatesOf(this.ctx),
      ledger: {
        available: Boolean(storage?.repo) && scopeIdOf(this.ctx) !== null,
        note: 'verification reads the ONE BOOP ledger; it never writes it',
      },
      verifier: {
        attemptLimit: Math.max(1, this.runtime.config.maxAttempts ?? DEFAULT_HEAL_ATTEMPT_LIMIT),
        attemptsRecorded: this.runtime.attempts.size(),
        modelCalls: 0,
        executesCommands: false,
        readsArbitraryFiles: false,
      },
      tool: { name: VERIFY_TOOL_NAME, registered: toolRegistered(this.ctx) },
      relatedTools: { boop_catalog: toolRegistered(this.ctx, 'boop_catalog') },
      endpoints: VERIFY_ENDPOINTS,
    }
  }
}

for (const method of ['verify', 'previewHeal', 'status']) {
  remote(method)(BoopVerifyApi.prototype)
}

/* ── audit sink: BOOP ledger with an honest memory fallback ──────────── */

class VerifyAuditSink {
  private readonly ctx: any
  private readonly memory: Array<Record<string, unknown>> = []

  constructor(ctx: any) {
    this.ctx = ctx
  }

  record(input: { kind: string; taskId: string; detail: string }): { sink: string; persisted: boolean; kind: string } {
    try {
      const storage = storageOf(this.ctx)
      const scopeId = scopeIdOf(this.ctx)
      if (storage?.repo && scopeId !== null && typeof storage.repo.audit === 'function') {
        storage.repo.audit(scopeId, input.kind, input.taskId === '' ? null : input.taskId, 'system', input.detail)
        return { sink: 'ledger', persisted: true, kind: input.kind }
      }
    } catch {
      /* memory fallback below */
    }
    this.memory.push({ kind: input.kind, taskId: input.taskId, detail: input.detail })
    if (this.memory.length > 100) this.memory.splice(0, this.memory.length - 100)
    return { sink: 'memory', persisted: false, kind: input.kind }
  }
}

/* ── in-process facade (future controllers / other rows) ─────────────── */

export interface BoopVerifyRules {
  verify(request?: unknown): VerifyResultFacts
  previewHeal(request?: unknown): PreviewHealResponse
  status(request?: unknown): VerifyStatusResponse
}

/* ── row lifecycle ────────────────────────────────────────────────────── */

export function apply(ctx: any, config: BoopVerifyConfig = {}): void {
  if (config.enabled === false) {
    try {
      ctx.logger?.info?.('[boop] verification plane disabled by config; host continues')
    } catch {
      /* logging must never break activation */
    }
    return
  }
  try {
    const runtime = createVerifyRuntime(ctx, config)
    const api = new BoopVerifyApi(ctx, runtime)
    // A separate key so other rows/tools reuse the SAME verifier + attempt ledger
    // instead of constructing a second service that shadows the Remote binding.
    const rules: BoopVerifyRules = {
      verify: (request?: unknown) => api.verify(request),
      previewHeal: (request?: unknown) => api.previewHeal(request),
      status: (request?: unknown) => api.status(request),
    }
    ctx.provide('boopVerifyRules', rules)
    ctx.logger?.info?.(
      '[boop] verification plane armed: read-only evidence verification + bounded self-heal preview (write mode closed → preview only, audited)',
    )
  } catch (error) {
    // A throwing optional row must warn, never break the host boot (03§05).
    try {
      ctx.logger?.warn?.('[boop] verification plane failed to arm; host continues', error)
    } catch {
      /* logging itself must never break activation */
    }
  }
}
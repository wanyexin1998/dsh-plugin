/**
 * BOOP runtime pre-step gate (G04 closure) — framework-free core.
 *
 * rc.2.1 official hook (verified against the installed payload's generated
 * Cordis surface, `@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js` and
 * `@deepseek-ai/dsh-agent/README.md`):
 *
 *   'agent/pre-step' (waterfall)
 *     (this: Scoped<Agent>, payload: { agent, messages: UserMessage[], turn,
 *       step, signal }, next: () => Promise<PreStepDecision>)
 *       => Promise<PreStepDecision>
 *
 *   PreStepDecision = { kind: 'reject' } | { kind: 'enter', messages, startsRequestSeries? }
 *
 * The listener is installed by `pre-step-api.ts` (row `boop-gate`). It runs
 * AFTER the turn opened and the inbox batch was claimed, but BEFORE `step/start`,
 * `agent/request`, `prepareCall()` and any model call. That is the earliest
 * official WATERFALL that can veto a step: the `agent/inbox/*` events are
 * emit-only, and `agent/request` already follows step admission.
 *
 * Consequences that are reported honestly in the evidence instead of hidden:
 *  - a rejected step still leaves a durable `turn/start` + `turn/end(reason:
 *    blocked)` pair (the loop logs the turn boundary before pre-step); NO
 *    `step/start`, no user/message commit and NO model request happen;
 *  - the claimed batch is removed from the inbox before pre-step, so a rejection
 *    cannot "put it back": this runtime therefore WAITS for the explicit human
 *    release (bounded, abortable) instead of rejecting a tracked BOOP command
 *    that is merely not released yet. A command this process never tracked
 *    (e.g. left in a native inbox by a previous Host run) is fail-closed
 *    rejected immediately — no execution, and the evidence notes that the
 *    dropped claim is not resurrectable without durable inbox re-admission work;
 *  - non-BOOP messages: the decision from `next()` is passed through unchanged;
 *    this gate never blocks a human message.
 *
 * One execution per release: after a released command is allowed once, its
 * message id is marked consumed for the life of the process; a second claim of
 * the same id is fail-closed rejected (never a second execution).
 */

import { isBoopMessage } from '../transport/command-envelope.ts'

export const PRE_STEP_HOOK = 'agent/pre-step'
export const PRE_STEP_ROW_ID = 'boop-gate'
export const PRE_STEP_REMOTE_NAMESPACE = 'boopGate'

export interface PreStepMessageLike {
  id?: unknown
  source?: { kind?: unknown }
}

export interface GateEntryLike {
  messageId: string
  actionId: string
  sessionId: string
  state: 'blocked' | 'released'
  reason: string
}

export interface PreStepAuditRecord {
  kind: string
  objectId: string | null
  reason: string | null
}

export interface PreStepAuditReceipt {
  sink: 'ledger' | 'memory' | string
  recorded: boolean
  id: string | null
}

/**
 * The live BOOP side this gate needs. Everything is a function so the row can
 * read the real `boop` service lazily (the gate may be disabled/unavailable
 * without taking the Host down) and so unit tests can fake it.
 */
export interface RuntimeGatePort {
  /** false = the `boop` service/gate is not composed on this Host. */
  available(): boolean
  armed(): boolean
  entries(): GateEntryLike[]
  /** Host-side registry of message ids BOOP itself minted in this process. */
  knownMessageIds(): ReadonlySet<string>
  v2AdmissionAllows?(messageId: string): boolean
  recordAdmission?(messageId: string, turnId: string): void
  scopeId(): string | null
  audit(record: PreStepAuditRecord): PreStepAuditReceipt
}

export type PreStepDecisionLike =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: unknown[]; startsRequestSeries?: boolean }

export interface PreStepPayloadLike {
  agent?: { id?: unknown; session?: { id?: unknown } }
  messages?: unknown[]
  turn?: number
  step?: number
  signal?: AbortSignal
}

export interface PreStepLastDecision {
  at: string
  decision: 'allow' | 'reject'
  reason: string | null
  sessionId: string | null
  turn: number | null
  step: number | null
  messageIds: string[]
}

export interface PreStepStatusFacts {
  schemaVersion: 1
  product: 'BOOP'
  row: typeof PRE_STEP_ROW_ID
  remoteService: typeof PRE_STEP_REMOTE_NAMESPACE
  hook: typeof PRE_STEP_HOOK
  mode: 'waterfall'
  registered: boolean
  gateAvailable: boolean
  armed: boolean
  entries: GateEntryLike[]
  consumedMessageIds: string[]
  waitTimeoutMs: number
  counters: {
    batches: number
    boopMessages: number
    allowed: number
    blocked: number
    timeouts: number
    passThroughBatches: number
  }
  lastDecision: PreStepLastDecision | null
  runtimeEnforcement: { composed: boolean; detail: string }
  generatedAt: string
}

export interface PreStepRuntimeOptions {
  waitTimeoutMs?: number
  pollMs?: number
  now?: () => string
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_WAIT_TIMEOUT_MS = 120_000
const DEFAULT_POLL_MS = 250

/** Reason codes are stable strings so evidence/tests can assert them verbatim. */
export const PRE_STEP_REASON = {
  gateUnavailable: 'gate-unavailable',
  gateUnarmed: 'gate-unarmed',
  notTracked: 'not-tracked',
  alreadyExecuted: 'already-executed',
  releaseTimeout: 'release-timeout',
  aborted: 'aborted',
} as const

interface BoopClaim {
  messageId: string
  message: unknown
}

/**
 * The runtime gate itself. One instance per Host process; the row owns it.
 */
export class PreStepRuntimeGate {
  readonly waitTimeoutMs: number
  readonly pollMs: number
  private readonly port: RuntimeGatePort
  private readonly now: () => string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly consumed = new Set<string>()
  private readonly counters = {
    batches: 0,
    boopMessages: 0,
    allowed: 0,
    blocked: 0,
    timeouts: 0,
    passThroughBatches: 0,
  }

  private lastDecision: PreStepLastDecision | null = null
  private registered = false

  constructor(port: RuntimeGatePort, options: PreStepRuntimeOptions = {}) {
    this.port = port
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.now = options.now ?? (() => new Date().toISOString())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Called by the row once the waterfall listener is installed. */
  markRegistered(): void {
    this.registered = true
  }

  /** The exact `agent/pre-step` waterfall handler the row installs. */
  async handle(
    payload: PreStepPayloadLike,
    next: () => Promise<PreStepDecisionLike>,
  ): Promise<PreStepDecisionLike> {
    this.counters.batches += 1
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const boopClaims = this.boopClaims(messages)
    if (boopClaims.length === 0) {
      this.counters.passThroughBatches += 1
      // Non-BOOP messages are NEVER blocked: pass the downstream decision through
      // untouched (including any message replacement a later listener makes).
      return await next()
    }

    this.counters.boopMessages += boopClaims.length
    const sessionId = this.sessionOf(payload)
    const human = messages.some((message) => this.isDirectHuman(message))
    if (human) return this.handleMixed(payload, messages, boopClaims, sessionId, next)
    const blocked: Array<{ messageId: string; reason: string }> = []
    const allowed: string[] = []

    for (const claim of boopClaims) {
      const outcome = await this.evaluate(claim, sessionId, payload.signal)
      if (outcome.kind === 'allow') allowed.push(claim.messageId)
      else blocked.push({ messageId: claim.messageId, reason: outcome.reason })
    }

    if (blocked.length > 0) {
      for (const entry of blocked) {
        this.audit('gate/pre-step-blocked', entry.messageId, `${entry.reason}; session=${sessionId ?? 'unknown'}`)
        this.counters.blocked += 1
        if (entry.reason === PRE_STEP_REASON.releaseTimeout || entry.reason === PRE_STEP_REASON.aborted) {
          this.counters.timeouts += 1
        }
      }
      this.lastDecision = {
        at: this.now(),
        decision: 'reject',
        reason: blocked.map((entry) => `${entry.messageId}:${entry.reason}`).join(','),
        sessionId,
        turn: typeof payload.turn === 'number' ? payload.turn : null,
        step: typeof payload.step === 'number' ? payload.step : null,
        messageIds: blocked.map((entry) => entry.messageId),
      }
      // Reject: no step/start, no model request. The claimed batch is NOT
      // resurrected (rc.2.1 claim already removed it from the inbox); this is
      // reported in the evidence as the known boundary of this hook.
      return { kind: 'reject' }
    }

    // All BOOP claims released: consume BEFORE admission so a second claim of the
    // same id can never run again, then take the downstream decision unchanged.
    for (const messageId of allowed) {
      this.consumed.add(messageId)
      this.counters.allowed += 1
      this.audit('gate/pre-step-allowed', messageId, `released; session=${sessionId ?? 'unknown'}`)
    }
    this.lastDecision = {
      at: this.now(),
      decision: 'allow',
      reason: null,
      sessionId,
      turn: typeof payload.turn === 'number' ? payload.turn : null,
      step: typeof payload.step === 'number' ? payload.step : null,
      messageIds: allowed,
    }
    return await next()
  }

  /** Read-only facts for the Remote plane and the evidence. */
  status(): PreStepStatusFacts {
    let available = false
    let armed = false
    let entries: GateEntryLike[] = []
    try {
      available = this.port.available()
      if (available) {
        armed = this.port.armed()
        entries = this.port.entries()
      }
    } catch {
      available = false
    }
    return {
      schemaVersion: 1,
      product: 'BOOP',
      row: PRE_STEP_ROW_ID,
      remoteService: PRE_STEP_REMOTE_NAMESPACE,
      hook: PRE_STEP_HOOK,
      mode: 'waterfall',
      registered: this.registered,
      gateAvailable: available,
      armed,
      entries,
      consumedMessageIds: [...this.consumed],
      waitTimeoutMs: this.waitTimeoutMs,
      counters: { ...this.counters },
      lastDecision: this.lastDecision,
      runtimeEnforcement: this.enforcement(),
      generatedAt: this.now(),
    }
  }

  /**
   * The exact fact the control plane reports as
   * `recovery.runtimeEnforcement`: composed only when the row registered the
   * waterfall listener on THIS Host composition.
   */
  enforcement(): { composed: boolean; detail: string } {
    if (!this.registered) {
      return {
        composed: false,
        detail: 'boop-gate 行未注册 agent/pre-step 监听：释放只改变门禁账本，不代表运行时会放行（fail-open for BOOP? no — see row state）。',
      }
    }
    return {
      composed: true,
      detail:
        `agent/pre-step waterfall 已注册（boop-gate）：BOOP 代理命令在 step/start 与模型调用之前拦截；` +
        `只有人类显式 release 且仅一次放行；未跟踪/未释放/门禁不可用一律 fail-closed。` +
        `已知边界：被拒绝的批次已被 inbox claim 取走（turn/start+turn/end 仍会落盘，无 step/model）。`,
    }
  }

  /* ── internals ──────────────────────────────────────────────────────── */

  private boopClaims(messages: unknown[]): BoopClaim[] {
    let known: ReadonlySet<string> = new Set()
    try {
      known = this.port.knownMessageIds()
    } catch {
      known = new Set()
    }
    const claims: BoopClaim[] = []
    for (const message of messages) {
      if (!isBoopMessage(message, known)) continue
      const id = (message as PreStepMessageLike).id
      if (typeof id === 'string' && id.length > 0) claims.push({ messageId: id, message })
    }
    return claims
  }

  private sessionOf(payload: PreStepPayloadLike): string | null {
    const agent = payload.agent
    const direct = agent?.id
    if (typeof direct === 'string' && direct.length > 0) return direct
    const nested = agent?.session?.id
    if (typeof nested === 'string' && nested.length > 0) return nested
    return null
  }

  /** Allow only when explicitly released and not yet executed; otherwise wait or fail closed. */
  private async evaluate(
    claim: BoopClaim,
    sessionId: string | null,
    signal: AbortSignal | undefined,
  ): Promise<{ kind: 'allow' } | { kind: 'block'; reason: string }> {
    if (this.consumed.has(claim.messageId)) return { kind: 'block', reason: PRE_STEP_REASON.alreadyExecuted }
    if (this.v2Allows(claim.messageId)) return { kind: 'allow' }
    let available = false
    try {
      available = this.port.available()
    } catch {
      available = false
    }
    if (!available) return { kind: 'block', reason: PRE_STEP_REASON.gateUnavailable }

    const started = Date.now()
    while (true) {
      let armed = false
      let entries: GateEntryLike[] = []
      try {
        armed = this.port.armed()
        entries = this.port.entries()
      } catch {
        return { kind: 'block', reason: PRE_STEP_REASON.gateUnavailable }
      }
      if (!armed) return { kind: 'block', reason: PRE_STEP_REASON.gateUnarmed }
      const entry = entries.find((candidate) => candidate.messageId === claim.messageId)
      if (entry === undefined) {
        // Not tracked by THIS process (e.g. a previous run's inbox command):
        // fail-closed, never best-effort execution.
        return { kind: 'block', reason: PRE_STEP_REASON.notTracked }
      }
      if (entry.state === 'released') return { kind: 'allow' }
      if (this.consumed.has(claim.messageId)) return { kind: 'block', reason: PRE_STEP_REASON.alreadyExecuted }
      if (signal?.aborted) return { kind: 'block', reason: PRE_STEP_REASON.aborted }
      if (Date.now() - started >= this.waitTimeoutMs) {
        return { kind: 'block', reason: PRE_STEP_REASON.releaseTimeout }
      }
      await this.sleep(this.pollMs)
    }
  }

  private isDirectHuman(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false
    let known: ReadonlySet<string> = new Set()
    try { known = this.port.knownMessageIds() } catch { known = new Set() }
    if (isBoopMessage(message, known)) return false
    const kind = (message as { source?: { kind?: unknown } }).source?.kind
    return kind === 'user' || kind === undefined
  }

  private v2Allows(messageId: string): boolean {
    const port = this.port as RuntimeGatePort & { v2AdmissionAllows?: (messageId: string) => boolean }
    try { return port.v2AdmissionAllows?.(messageId) === true } catch { return false }
  }

  private async handleMixed(
    payload: PreStepPayloadLike,
    messages: unknown[],
    boopClaims: BoopClaim[],
    sessionId: string | null,
    next: () => Promise<PreStepDecisionLike>,
  ): Promise<PreStepDecisionLike> {
    const blocked = new Set<string>()
    for (const claim of boopClaims) {
      const outcome = this.evaluateNow(claim)
      if (outcome.kind === 'allow') {
        this.counters.allowed += 1
        this.recordV2(claim.messageId, payload)
      } else {
        blocked.add(claim.messageId)
        this.counters.blocked += 1
        this.audit('gate/pre-step-blocked', claim.messageId, `${outcome.reason}; mixed-batch; session=${sessionId ?? 'unknown'}`)
      }
    }
    const downstream = await next()
    if (downstream.kind === 'reject') return downstream
    const kept = (downstream.messages ?? messages).filter((message) => {
      const id = (message as { id?: unknown })?.id
      return typeof id !== 'string' || !blocked.has(id)
    })
    const substantive = kept.filter((message) => {
      const kind = (message as { source?: { kind?: unknown } }).source?.kind
      return kind !== 'runtime-context'
    })
    if (substantive.length === 0) return { kind: 'reject' }
    return { ...downstream, messages: kept }
  }

  private evaluateNow(claim: BoopClaim): { kind: 'allow' } | { kind: 'block'; reason: string } {
    if (this.consumed.has(claim.messageId)) return { kind: 'block', reason: PRE_STEP_REASON.alreadyExecuted }
    if (this.v2Allows(claim.messageId)) return { kind: 'allow' }
    try {
      if (!this.port.available()) return { kind: 'block', reason: PRE_STEP_REASON.gateUnavailable }
      if (!this.port.armed()) return { kind: 'block', reason: PRE_STEP_REASON.gateUnarmed }
      const entry = this.port.entries().find((candidate) => candidate.messageId === claim.messageId)
      if (!entry) return { kind: 'block', reason: PRE_STEP_REASON.notTracked }
      if (entry.state === 'released') return { kind: 'allow' }
      return { kind: 'block', reason: 'not-released' }
    } catch {
      return { kind: 'block', reason: PRE_STEP_REASON.gateUnavailable }
    }
  }

  private recordV2(messageId: string, payload: PreStepPayloadLike): void {
    const port = this.port as RuntimeGatePort & { recordAdmission?: (messageId: string, turnId: string) => void }
    try { port.recordAdmission?.(messageId, `turn:${payload.turn ?? 'unknown'}`) } catch { /* admission is best-effort beside the decision */ }
  }

  private audit(kind: string, messageId: string | null, reason: string | null): void {
    try {
      this.port.audit({ kind, objectId: messageId, reason })
    } catch {
      /* the gate decision itself must never be lost to an audit failure; the row
         records the memory-fallback sink in status facts instead. */
    }
  }
}

/** Build a port over the live `boop` service; every read is defensive. */
export function runtimeGatePortOf(ctx: any, options: { simulateUnavailable?: boolean } = {}): RuntimeGatePort {
  const unavailable = options.simulateUnavailable === true
  return {
    available(): boolean {
      if (unavailable) return false
      try {
        return typeof ctx.boop?.gate === 'function' && ctx.boop.gate() !== null
      } catch {
        return false
      }
    },
    armed(): boolean {
      return ctx.boop.gate().isArmed() === true
    },
    entries(): GateEntryLike[] {
      const entries: GateEntryLike[] = ctx.boop.gate().list() ?? []
      return entries.map((entry) => ({
        messageId: String(entry.messageId),
        actionId: String(entry.actionId),
        sessionId: String(entry.sessionId),
        state: entry.state === 'released' ? 'released' : 'blocked',
        reason: String(entry.reason ?? ''),
      }))
    },
    v2AdmissionAllows(messageId: string): boolean {
      try {
        const db = ctx.boop?.storage?.()?.db?.db
        if (!db) return false
        const row = db.prepare(`SELECT state FROM action WHERE message_id = ? AND managed_v2 = 1`).get(messageId) as { state?: string } | undefined
        return row?.state === 'dispatching' || row?.state === 'accepted' || row?.state === 'running'
      } catch {
        return false
      }
    },
    recordAdmission(messageId: string, turnId: string): void {
      try {
        const db = ctx.boop?.storage?.()?.db?.db
        if (!db) return
        db.prepare(
          `INSERT INTO action_admission(action_id,scope_id,message_id,target_generation,turn_id,admitted_at)
           SELECT id, scope_id, message_id, 'observed', ?, ?
           FROM action WHERE message_id = ? AND managed_v2 = 1
           ON CONFLICT(action_id, scope_id) DO NOTHING`,
        ).run(turnId, new Date().toISOString(), messageId)
      } catch {
        /* schema 1 or a missing action must not throw out of the gate */
      }
    },
    knownMessageIds(): ReadonlySet<string> {
      const ids: string[] = ctx.boop.proxyMessageIds?.() ?? []
      return new Set(ids.map((id) => String(id)))
    },
    scopeId(): string | null {
      try {
        return String(ctx.boop.storage()?.identity?.scopeId ?? '') || null
      } catch {
        return null
      }
    },
    audit(record: PreStepAuditRecord): PreStepAuditReceipt {
      try {
        const storage = ctx.boop.storage()
        const repo = storage?.repo
        const scopeId = storage?.identity?.scopeId
        if (repo && typeof repo.audit === 'function' && typeof scopeId === 'string') {
          const row = repo.audit(scopeId, record.kind, record.objectId, 'boop-gate', record.reason)
          return { sink: 'ledger', recorded: true, id: row?.id === undefined ? null : String(row.id) }
        }
      } catch {
        /* fall through to the in-memory receipt below */
      }
      return { sink: 'memory', recorded: false, id: null }
    },
  }
}

/**
 * BOOP logical API service (the Remote service object itself).
 *
 * Kept in its own module so `api.ts` can export an unambiguous Cordis
 * function-plugin (`name` / `inject` / `apply`). A module that exports BOTH a
 * plugin class and a function-plugin makes the loader's choice ambiguous on
 * rc.2; the class stays private to this file.
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { remote } from './remote.ts'
import {
  initPlanFacts,
  mainSessionFacts,
  sourcesFacts,
  type InitPlanFacts,
  type MainSessionFacts,
  type SourcesFacts,
} from './main-session.ts'
import { DshAdapter } from './transport/dsh-adapter.ts'
import { PROXY_SOURCE_KIND, type CommandEnvelope } from './transport/command-envelope.ts'
import { Dispatcher, type DispatchOutcome, type ReconcileReport } from './dispatch/dispatcher.ts'
import { GATE_LEDGER, type GateEntry, type GateState, type WriteModeStatus } from './gates.ts'
import { applyInitialization, collectInitHeads } from './memory/host-init.ts'
import { pocRequested } from './poc-switch.ts'

/* ── PoC-only raw ledger reads for reconciliation (no writes here) ────── */

interface PocReconcileRequest {
  actionId?: string
  actionIds?: string[]
  sessionId?: string
  /** Explicit operator retry of an ALREADY EXISTING action id (never a new id). */
  retry?: boolean
  instruction?: string
  mode?: string
  /** Operator attestation that the previous Host stopped gracefully. */
  cleanRestart?: boolean
}

interface PocReconcileFacts {
  available: boolean
  reason: string | null
  scopeId: string | null
  ledgerWritable: boolean
  cleanRestart: boolean
  boot:
    | { unknown: string[]; blockedByGate: string[]; readyToRetry: number }
    | null
  dispatch: DispatchOutcome | null
  report: ReconcileReport | null
  /** Raw durable-trace summary per reconciled action (evidence transport). */
  evidence: Array<{
    actionId: string
    verdict: string
    reason: string
    changed: boolean
    messageId: string | null
    evidenceKind: string
    evidenceSeq: number | null
    headSeq: number | null
    headTimeMs: number | null
    sinceMs: number | null
    candidates: number | null
    truncated: boolean
  }>
  error: string | null
}

function rawDbOf(ctx: any): any | null {
  try {
    return ctx.boop?.storage?.()?.db?.db ?? null
  } catch {
    return null
  }
}

function readOutboxState(ctx: any, scopeId: string, actionId: string): string | null {
  try {
    const db = rawDbOf(ctx)
    if (!db) return null
    const row = db
      .prepare('SELECT state FROM command_outbox WHERE scope_id = ? AND action_id = ?')
      .get(scopeId, actionId) as { state?: string } | undefined
    return row?.state ?? null
  } catch {
    return null
  }
}

function readActionPayload(ctx: any, scopeId: string, actionId: string): { instruction: string | null; mode: string | null } {
  try {
    const db = rawDbOf(ctx)
    if (!db) return { instruction: null, mode: null }
    const row = db
      .prepare('SELECT payload_json FROM action WHERE scope_id = ? AND id = ?')
      .get(scopeId, actionId) as { payload_json?: string } | undefined
    if (typeof row?.payload_json !== 'string') return { instruction: null, mode: null }
    const payload = JSON.parse(row.payload_json) as { instruction?: unknown; mode?: unknown }
    return {
      instruction: typeof payload.instruction === 'string' ? payload.instruction : null,
      mode: typeof payload.mode === 'string' ? payload.mode : null,
    }
  } catch {
    return { instruction: null, mode: null }
  }
}

function readActionCreatedAt(ctx: any, scopeId: string, actionId: string): string | null {
  try {
    const db = rawDbOf(ctx)
    if (!db) return null
    const row = db.prepare('SELECT created_at FROM action WHERE scope_id = ? AND id = ?').get(scopeId, actionId) as
      | { created_at?: string }
      | undefined
    return typeof row?.created_at === 'string' ? row.created_at : null
  } catch {
    return null
  }
}

function readUnknownActionIds(ctx: any, scopeId: string, sessionId: string | null): string[] {
  try {
    const db = rawDbOf(ctx)
    if (!db) return []
    const where = sessionId === null ? '' : ' AND a.target_session_id = ?'
    const params: unknown[] = sessionId === null ? [scopeId] : [scopeId, sessionId]
    const rows = db
      .prepare(
        `SELECT a.id FROM action a
           LEFT JOIN command_outbox o ON o.action_id = a.id AND o.scope_id = a.scope_id
          WHERE a.scope_id = ?${where} AND (a.state = 'outcome_unknown' OR o.state IN ('unknown', 'sending'))
          ORDER BY a.id`,
      )
      .all(...params) as Array<{ id: string }>
    return rows.map((row) => String(row.id))
  } catch {
    return []
  }
}

export interface BoopApiConfig {
  /** Enables the E00-02 proof endpoints. Never enabled in a user profile. */
  pocEnabled: boolean
}

export interface BoopBootstrap {
  schemaVersion: 1
  product: 'BOOP'
  scope: {
    dshProfileVersion: string
    dshCommit: string
    writeModeEnabled: boolean
    recoveryGateArmed: boolean
  }
  capabilities: Record<string, boolean>
  gates: Record<string, GateState>
  /** One entry per frozen gate with the honest evidence (or the gap) behind it. */
  gateEvidence: readonly GateEntry[]
  /** Why the production write mode is on/off right now (derived from evidence). */
  writeMode: WriteModeStatus
  /** Live host service names (read-only diagnostic; E00-01 evidence). */
  services: string[]
  /** Ledger and single-writer facts (E01-01), or null when storage is off. */
  storage: unknown
}

/** Effective row configuration; the shipped default keeps the PoC off. */
let apiConfig: BoopApiConfig = { pocEnabled: false }

/** One durable Session event, reduced to what reconciliation needs. */
export interface DurableEventFacts {
  seq: number
  type: string
  time: number
  /** `user/message` / `agent/inbox/claimed` / `assistant/message` message id. */
  messageId: string | null
  /** The message's own provenance tag (`boop-command`, `user`, `model`, …). */
  sourceKind: string | null
  /** BOOP action id carried by the proxy envelope. */
  actionId: string | null
  /** Provider-reported model identity on assistant messages. */
  provider: string | null
  model: string | null
  /** Model/user text, truncated for evidence transport. */
  text: string | null
  /** `turn/end` reason kind (completed / error / aborted / …) and error text. */
  turnEnd: string | null
  turn: number | null
  /** `agent/inbox/spliced`: target list, ids inserted, ids/count removed. */
  spliceTarget: string | null
  insertedIds: string[] | null
  removedCount: number | null
}

/** One runtime `agent/inbox/claimed` observation (never durable on rc.2.1). */
export interface ClaimFact {
  sessionId: string | null
  messageId: string
  sourceKind: string
  actionId: string | null
  turn: number | null
  at: string
}

/** Durable reconciliation facts for one real Session (E02-03). */
export interface RecordFacts {
  available: boolean
  reason: string | null
  detail: string | null
  sessionId: string
  headSeq: number | null
  capturedFromSeq: number | null
  capturedThroughSeq: number | null
  /** True when the requested tail window did not reach seq 0. */
  truncated: boolean
  events: DurableEventFacts[]
  userMessages: DurableEventFacts[]
  claimed: DurableEventFacts[]
  assistant: DurableEventFacts[]
  turnEnds: DurableEventFacts[]
  inbox: {
    nextTurn: Array<{ id: string; sourceKind: string }>
    nextStep: Array<{ id: string; sourceKind: string }>
  } | null
}

export function configureApi(config?: BoopApiConfig): BoopApiConfig {
  if (config) {
    apiConfig = { ...apiConfig, ...config, pocEnabled: pocRequested(config.pocEnabled) }
  }
  return apiConfig
}

export class BoopApi extends TypertRemoteService {
  /**
   * Host services this row depends on, resolved through a scoped context.
   * The Remote service itself is registered on the row's context; the extra
   * sessions/projections are only needed by the PoC proof surface.
   */
  private host: any = null

  /**
   * Runtime `agent/inbox/claimed` observations for the E02-03 PoC surface.
   * rc.2.1 emits this event on the Agent dispatch bus only, so it is captured
   * live (bounded) rather than read back from the durable log.
   */
  private claims: ClaimFact[] = []
  private claimsSubscribed = false

  constructor(ctx: any) {
    super(ctx, 'boopApi', { namespace: 'boop' })
    ctx.inject(['sessions', 'sessionProjections'], (child) => {
      this.host = child
    })
    if (apiConfig.pocEnabled) this.subscribeClaims()
  }

  /** Read-only bootstrap: identity, capability facts, gate ledger. */
  bootstrap(): BoopBootstrap {
    const state = this.ctx.boop.state()
    return {
      schemaVersion: 1,
      product: 'BOOP',
      scope: {
        dshProfileVersion: state.dshProfileVersion,
        dshCommit: state.dshCommit,
        writeModeEnabled: state.writeModeEnabled,
        recoveryGateArmed: state.recoveryGateArmed,
      },
      capabilities: this.ctx.boop.capabilities(),
      gates: state.gates,
      gateEvidence: GATE_LEDGER,
      writeMode: state.writeMode,
      services: state.probe?.services ?? [],
      storage: state.storage,
    }
  }

  /**
   * E00-02 proof surface: seed one synthetic Session whose durable inbox holds a
   * BOOP proxy command, through the host's public session-creation/replay API.
   * No model call, no user Session, no project.
   */
  pocSeedInbox(sessionId: string, instruction?: string, taskId?: string): {
    sessionId: string
    actionId: string
    messageId: string
    sourceKind: string
    pending: number
  } {
    this.assertPocEnabled()
    const prepared = this.ctx.boop.prepareProxyCommand({
      scopeId: 'local-scope',
      taskId: taskId ?? 'task-poc',
      taskVersion: 1,
      targetSessionId: sessionId,
      instruction: instruction ?? 'BOOP PoC: continue the current task',
      mode: 'queue',
      initiatorRef: 'dsh:operator',
      policyEpoch: 1,
    })
    const seeded = { ...(prepared.message as Record<string, unknown>), id: prepared.messageId }
    this.requireHost().sessions.create(sessionId, {
      // Only the inbox splice is seeded: the store synthesizes the minimal
      // session header when a session is created without one.
      seed: [
        {
          type: 'agent/inbox/spliced',
          seq: 0,
          time: 0,
          data: { target: 'next-turn', start: 0, inserted: [seeded] },
        },
      ],
      meta: { cwd: process.cwd() },
    })
    return {
      sessionId,
      actionId: prepared.actionId,
      messageId: prepared.messageId,
      sourceKind: this.ctx.boop.proxySourceKind,
      pending: this.pendingMessages(sessionId).length,
    }
  }

  /** Read the reconstructed inbox projection for one synthetic Session. */
  pocInbox(sessionId: string): {
    sessionId: string
    nextTurn: Array<{ id: string; sourceKind: string }>
    nextStep: Array<{ id: string; sourceKind: string }>
  } {
    this.assertPocEnabled()
    const state = this.inboxState(sessionId)
    return {
      sessionId,
      nextTurn: summarize(state['next-turn']),
      nextStep: summarize(state['next-step']),
    }
  }

  /** Run the startup recovery gate against one Session's pending messages. */
  pocGateDecision(sessionId: string): {
    allow: boolean
    reason?: string
    gateArmed: boolean
    entries: Array<{ messageId: string; actionId: string; state: string; reason: string }>
  } {
    this.assertPocEnabled()
    const decision = this.ctx.boop.gate().decide(this.pendingMessages(sessionId))
    return {
      allow: decision.allow,
      reason: decision.reason,
      gateArmed: this.ctx.boop.gate().isArmed(),
      entries: this.ctx.boop.gate().list().map((entry) => ({ ...entry })),
    }
  }

  /**
   * E04-01 read-only/idempotent main-Session identity: bind once in BOOP's own
   * ledger (`scopes.main_session_id`), then only read. It never creates a DSH
   * Session and never dispatches anything into a Session — the browser opens
   * the identity through the native Session surface.
   */
  mainSession(): MainSessionFacts {
    return mainSessionFacts(this.ctx)
  }

  /**
   * E04-01 read-only Source coverage: what the ledger actually holds per Session
   * generation. An unreadable plane is reported as unavailable, never as an
   * empty list (FE-11); discovery never creates or wakes an Agent.
   */
  async sources(): Promise<SourcesFacts> {
    return await sourcesFacts(this.ctx)
  }

  /**
   * E04-01 read-only initialization plan: why one of the three E03-03 modes
   * cannot run right now, with real evidence. Writes nothing, ever; no branch
   * reports a fake PASS.
   */
  async initPlan(mode: string): Promise<InitPlanFacts> {
    return await initPlanFacts(this.ctx, mode)
  }

  /**
   * Apply one initialization mode. Writes only when write mode and the writer
   * lease are both held; otherwise the result matches the read-only plan.
   */
  async initApply(mode: string): Promise<InitPlanFacts> {
    const heads = await collectInitHeads(this.ctx)
    return await applyInitialization(this.ctx, mode, heads)
  }

  /**
   * E03-01 read-only discovery: every Session in the data domain plus BOOP's
   * durable read watermark. Creates nothing, wakes nothing.
   */
  async observeSources(): Promise<{
    scopeId: string
    discovered: number
    /** Sources whose head was not resolved this scan (reported, never hidden). */
    headDeferred: string[]
    sources: Array<{
      sessionId: string
      sourceGeneration: string
      title: string | null
      headSeq: number | null
      throughSeq: number | null
      state: string
    }>
  }> {
    this.assertPocEnabled()
    const boop = this.ctx.boop
    const observer = boop.observer?.()
    const reader = boop.sourceReader?.()
    const storage = boop.storage?.()
    if (!observer || !reader || !storage) {
      throw new Error('boop: observation plane is unavailable (no ledger)')
    }
    const scan = await observer.scan()
    const cursors = storage.repo.cursors(storage.identity.scopeId)
    const resolveHeadFor = new Set(
      cursors.filter((cursor) => cursor.state !== 'excluded').map((cursor) => cursor.sessionId),
    )
    const sources = await reader.listSources({ resolveHeadFor })
    return {
      scopeId: storage.identity.scopeId,
      discovered: scan.discovered,
      headDeferred: scan.headDeferred,
      sources: sources.map((source) => {
        const cursor = cursors.find((row) => row.sessionId === source.sessionId && row.sourceGeneration === source.sourceGeneration)
        return {
          sessionId: source.sessionId,
          sourceGeneration: source.sourceGeneration,
          title: source.title,
          headSeq: source.headSeq,
          throughSeq: cursor ? cursor.throughSeq : null,
          state: cursor ? cursor.state : 'unseen',
        }
      }),
    }
  }

  /** Gate status without touching any Session (used by the restart check). */
  pocGateStatus(): {
    gateArmed: boolean
    entries: Array<{ messageId: string; actionId: string; sessionId: string; state: string }>
    adoptedMessageIds: string[]
  } {
    this.assertPocEnabled()
    return {
      gateArmed: this.ctx.boop.gate().isArmed(),
      entries: this.ctx.boop.gate().list().map((entry) => ({
        messageId: entry.messageId,
        actionId: entry.actionId,
        sessionId: entry.sessionId,
        state: entry.state,
      })),
      adoptedMessageIds: this.ctx.boop.proxyMessageIds(),
    }
  }

  /** Explicit, audited release of specific commands (the human recovery act). */
  pocRelease(messageIds: string[]): { released: string[] } {
    this.assertPocEnabled()
    return {
      released: this.ctx.boop.gate().release(messageIds ?? []).map((entry) => entry.messageId),
    }
  }

  /* ── E02-03 REAL dispatch / reconciliation surface (PoC only) ──────────
   *
   * These endpoints exist so ONE real test can drive a REAL Session through the
   * real host Agent with the real model, instead of a synthetic inbox:
   *  - `pocResolveAgent` proves `SessionController.resolveAgent()` works for an
   *    existing Session in this composition;
   *  - `pocDispatch` mints one BOOP proxy command (`prepareProxyCommand`, which
   *    records the message id in the host-side registry and tracks the gate) and
   *    delivers it through the Agent's own `followup`/`steer` (never through the
   *    human `session/prompt` path, which hardcodes `source.kind = 'user'`);
   *  - `pocSessionRecord` reads the DURABLE log back through the read-only
   *    `sessionQuery` plane (`listEvents` + `readEvent`), so provenance
   *    (`source.kind`, message id, action id), `agent/inbox/claimed`
   *    reconciliation and the model's own reply are observed as stored facts.
   *
   * Nothing here changes production semantics: `pocEnabled` stays false in the
   * shipped profile, no browser code calls these, and the endpoints only touch
   * a Session the caller names.
   */

  /** Resolve (create or resume) the live Agent for one real Session. */
  async pocResolveAgent(sessionId: string): Promise<{
    sessionId: string
    liveBefore: boolean
    resolved: boolean
    agentId: string | null
    cwd: string | null
    error: string | null
  }> {
    this.assertPocEnabled()
    const id = sessionIdOf(sessionId)
    const agents = this.ctx.reflect?.get?.('agents', false)
    const liveBefore = Boolean(agents?.get?.(id))
    const adapter = new DshAdapter({ ctx: this.ctx })
    try {
      const agent = await adapter.resolveAgent(id)
      const inspected = await adapter.inspectAgent(id)
      return {
        sessionId: id,
        liveBefore,
        resolved: Boolean(agent),
        agentId: inspected.agentId,
        cwd: inspected.cwd,
        error: agent ? inspected.error : inspected.error ?? 'resolveAgent returned no agent',
      }
    } catch (error) {
      return { sessionId: id, liveBefore, resolved: false, agentId: null, cwd: null, error: errorText(error) }
    }
  }

  /**
   * Deliver one BOOP proxy command to a real Session through the host Agent.
   *
   * The caller (operator/test) is the initiator; `release` performs the explicit
   * recovery act on the command this same call minted, so the gate ledger never
   * presents it as a stale previous-run command.
   */
  async pocDispatch(
    sessionId: string,
    instruction?: string,
    mode?: string,
    taskId?: string,
    release?: boolean,
  ): Promise<{
    sessionId: string
    accepted: boolean
    messageId: string
    actionId: string
    mode: 'queue' | 'steer'
    sourceKind: string
    agentResolved: boolean
    gateState: string | null
    error: string | null
    durationMs: number
  }> {
    this.assertPocEnabled()
    const id = sessionIdOf(sessionId)
    const dispatchMode: 'queue' | 'steer' = mode === 'steer' ? 'steer' : 'queue'
    const scopeId = String(this.ctx.boop.storage()?.identity?.scopeId ?? 'local-scope')
    const prepared = this.ctx.boop.prepareProxyCommand({
      scopeId,
      taskId: typeof taskId === 'string' && taskId !== '' ? taskId : 'task-e02-03-real',
      taskVersion: 1,
      targetSessionId: id,
      instruction:
        typeof instruction === 'string' && instruction !== ''
          ? instruction
          : 'BOOP E02-03 real dispatch probe: reply with exactly BOOP-OK and nothing else.',
      mode: dispatchMode,
      initiatorRef: 'dsh:operator',
      policyEpoch: 1,
    })
    const envelope: CommandEnvelope = {
      scopeId,
      taskId: typeof taskId === 'string' && taskId !== '' ? taskId : 'task-e02-03-real',
      taskVersion: 1,
      actionId: prepared.actionId,
      messageId: prepared.messageId,
      policyEpoch: 1,
      payloadHash: prepared.payloadHash,
      initiatorRef: 'dsh:operator',
      instruction:
        typeof instruction === 'string' && instruction !== ''
          ? instruction
          : 'BOOP E02-03 real dispatch probe: reply with exactly BOOP-OK and nothing else.',
      mode: dispatchMode,
    }
    const started = Date.now()
    let agentResolved = false
    let error: string | null = null
    let accepted = false
    try {
      const adapter = new DshAdapter({ ctx: this.ctx })
      // The dispatch is the explicit operator act for THIS command.
      if (release !== false) this.ctx.boop.gate().release([prepared.messageId])
      const result = await adapter.enqueueProxy({ envelope, targetSessionId: id })
      accepted = result.accepted
      agentResolved = accepted
      if (!accepted) error = 'the target Session has no resolvable Agent (or delivery was refused)'
    } catch (cause) {
      error = errorText(cause)
    }
    const tracked = this.ctx.boop.gate().list().find((entry) => entry.messageId === prepared.messageId)
    return {
      sessionId: id,
      accepted,
      messageId: prepared.messageId,
      actionId: prepared.actionId,
      mode: dispatchMode,
      sourceKind: PROXY_SOURCE_KIND,
      agentResolved,
      gateState: tracked ? tracked.state : null,
      error,
      durationMs: Date.now() - started,
    }
  }

  /**
   * G03 / AT-13 PoC-only reconciliation harness (dispatcher-layer idempotency).
   *
   * It is the test/diagnostic trigger for the REAL `Dispatcher`; it changes no
   * production semantics (`pocEnabled` is false in the shipped profile):
   *  1. boot reconciliation (`reconcile()`) marks a crashed `sending` row as
   *     `outcome_unknown` — it never re-sends;
   *  2. optional EXPLICIT retry (`retry:true` + an existing `actionId`): asks the
   *     dispatcher to dispatch THAT action id. If it was already delivered the
   *     dispatcher answers `duplicate` and nothing is sent; an unknown action is
   *     reconciled first and is only retried when the durable evidence proves it
   *     was NOT delivered. The message id is always the action id — a retry can
   *     never mint a new id.
   *  3. evidence-based reconciliation of the named/unknown actions
   *     (`reconcileUnknown`) with tri-state verdicts: accepted / not-delivered /
   *     indeterminate. Repeated calls are idempotent (changed:false, no second
   *     audit row).
   *
   * `cleanRestart:true` is the operator attestation that the previous Host
   * stopped gracefully; only then may absence of durable evidence mean
   * "not delivered" (an unclean SIGKILL can lose an unflushed durable tail).
   */
  async pocReconcile(request?: unknown): Promise<PocReconcileFacts> {
    this.assertPocEnabled()
    const raw = (typeof request === 'object' && request !== null ? request : {}) as PocReconcileRequest
    const storage = this.ctx.boop.storage()
    const scopeId = storage === null || storage === undefined ? null : String(storage.identity.scopeId)
    const blank: PocReconcileFacts = {
      available: false,
      reason: null,
      scopeId,
      ledgerWritable: false,
      cleanRestart: raw.cleanRestart === true,
      boot: null,
      dispatch: null,
      report: null,
      evidence: [],
      error: null,
    }
    if (storage === null || storage === undefined || scopeId === null) {
      return { ...blank, reason: 'ledger-unavailable' }
    }
    const writable = this.ctx.boop.state()?.storage?.ok === true
    if (!writable) {
      // Post-crash the stale lease may still be held; reconciliation needs the
      // ledger writer. Report it honestly instead of failing mid-way.
      return { ...blank, reason: 'ledger-read-only', ledgerWritable: false }
    }
    try {
      const adapter = new DshAdapter({ ctx: this.ctx })
      const knownMessageIds = (): ReadonlySet<string> => new Set<string>(this.ctx.boop.proxyMessageIds())
      const dispatcher = new Dispatcher({
        repo: storage.repo,
        scopeId,
        enqueue: (input) => adapter.enqueueProxy(input),
        knownMessageIds,
        pendingFor: (sessionId) => adapter.pendingProxyCommands(sessionId, knownMessageIds()),
        gateDecision: (claimed) => this.ctx.boop.gate().decide(claimed),
        evidence: (sessionId, options) => adapter.readDurableTrace(sessionId, { sinceMs: options.sinceMs, clean: options.clean }),
        outboxState: (actionId) => readOutboxState(this.ctx, scopeId, actionId),
        actionCreatedAt: (actionId) => readActionCreatedAt(this.ctx, scopeId, actionId),
        flush: (sessionId) => adapter.flush(sessionId),
        now: () => new Date().toISOString(),
      })

      // 1) Boot window: sending -> unknown, never a re-send.
      const boot = dispatcher.reconcile()

      // 2) Optional EXPLICIT retry of one existing action (same action/message id).
      const actionId = typeof raw.actionId === 'string' && raw.actionId !== '' ? raw.actionId : null
      let dispatchOutcome: DispatchOutcome | null = null
      if (raw.retry === true && actionId !== null) {
        const action = storage.repo.getAction(scopeId, actionId)
        if (action === null) {
          return { ...blank, available: true, ledgerWritable: true, boot, error: 'ACTION_NOT_FOUND' }
        }
        const payload = readActionPayload(this.ctx, scopeId, actionId)
        const instruction =
          typeof raw.instruction === 'string' && raw.instruction !== '' ? raw.instruction : payload.instruction
        const mode: 'queue' | 'steer' = raw.mode === 'steer' ? 'steer' : payload.mode === 'steer' ? 'steer' : 'queue'
        if (instruction === null || instruction === '') {
          return { ...blank, available: true, ledgerWritable: true, boot, error: 'INSTRUCTION_UNAVAILABLE' }
        }
        // PoC-only explicit operator act: track + release the recovery-gate entry
        // for THIS message id, exactly like a real planned proxy command would be
        // tracked by prepareProxyCommand and released by the operator. Without it
        // the rc.2.1 `agent/pre-step` gate (boop-gate, G04) fail-closes the turn.
        try {
          const gate = this.ctx.boop.gate()
          gate.track({
            sessionId: action.targetSessionId,
            actionId,
            messageId: actionId,
            reason: 'PoC reconcile: explicit operator retry of the same action id',
          })
          gate.release([actionId])
        } catch {
          /* the gate row is optional; the dispatch below reports its own outcome */
        }
        dispatchOutcome = await dispatcher.dispatch({
          taskId: action.taskId,
          expectedTaskVersion: action.taskVersion,
          targetSessionId: action.targetSessionId,
          instruction,
          mode,
          originRef: 'dsh:operator',
          policyEpoch: storage.repo.getScope(scopeId)?.policyEpoch ?? 1,
          actionId,
          cleanRestart: raw.cleanRestart === true,
        })
      }

      // 3) Evidence-based reconciliation.
      const explicitIds = Array.isArray(raw.actionIds)
        ? raw.actionIds.filter((id): id is string => typeof id === 'string' && id !== '')
        : []
      const sessionId = typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null
      const actionIds =
        actionId !== null ? [actionId] : explicitIds.length > 0 ? explicitIds : readUnknownActionIds(this.ctx, scopeId, sessionId)
      const report = await dispatcher.reconcileUnknown({ actionIds, cleanRestart: raw.cleanRestart === true })
      return {
        available: true,
        reason: null,
        scopeId,
        ledgerWritable: true,
        cleanRestart: raw.cleanRestart === true,
        boot,
        dispatch: dispatchOutcome,
        report,
        evidence: report.results.map((result) => ({
          actionId: result.actionId,
          verdict: result.verdict,
          reason: result.reason,
          changed: result.changed,
          messageId: result.messageId,
          evidenceKind: result.evidence.kind,
          evidenceSeq: result.evidence.seq,
          headSeq: result.evidence.headSeq,
          headTimeMs: result.evidence.headTimeMs ?? null,
          sinceMs: result.evidence.sinceMs ?? null,
          candidates: result.evidence.candidates ?? null,
          truncated: result.evidence.truncated,
        })),
        error: null,
      }
    } catch (error) {
      return { ...blank, available: true, ledgerWritable: true, error: errorText(error) }
    }
  }

  /**
   * Durable record of one real Session: the stored events that decide
   * provenance, reconcile the inbox claim, and carry the model's reply.
   *
   * Read-only: `sessionQuery.listEvents` (body-free index) plus `readEvent`
   * windows (full raw events). No Agent is created or woken.
   */
  async pocSessionRecord(sessionId: string, tailEvents?: number): Promise<RecordFacts> {
    this.assertPocEnabled()
    const id = sessionIdOf(sessionId)
    const query = this.ctx.reflect?.get?.('sessionQuery', false)
    if (!query || typeof query.listEvents !== 'function' || typeof query.readEvent !== 'function') {
      return { ...emptyRecord(id), available: false, reason: 'session-query-unavailable' }
    }

    let index: Array<{ seq: number; type: string; time: number }>
    try {
      const records = (await query.listEvents(id)) ?? []
      index = (records as Array<Record<string, unknown>>).map((row) => ({
        seq: Number(row.seq),
        type: String(row.type ?? ''),
        time: Number(row.time ?? 0),
      }))
    } catch (cause) {
      return { ...emptyRecord(id), available: false, reason: 'session-not-readable', detail: errorText(cause) }
    }
    if (index.length === 0) return { ...emptyRecord(id), available: true, reason: 'empty-log' }

    const requested = typeof tailEvents === 'number' && Number.isFinite(tailEvents)
      ? Math.max(1, Math.min(400, Math.trunc(tailEvents)))
      : 200
    const head = index[index.length - 1].seq
    const firstSeq = Math.max(0, head - requested + 1)
    const raw = new Map<number, Record<string, unknown>>()
    const WINDOW = 50
    for (let end = head; end >= firstSeq; end -= WINDOW) {
      const before = Math.min(WINDOW - 1, end - firstSeq)
      try {
        const window = await query.readEvent({ sessionId: id, seq: end, before, after: 0 })
        for (const event of window?.events ?? []) raw.set(Number(event.seq), event)
      } catch {
        /* a failed window is reported by the coverage fields below, never faked */
      }
    }

    const events: DurableEventFacts[] = []
    for (const row of index) {
      if (row.seq < firstSeq) continue
      const event = raw.get(row.seq)
      if (event === undefined) continue
      events.push(summarizeEvent(event))
    }

    const userMessages = events.filter((event) => event.type === 'user/message')
    const claimed = events.filter((event) => event.type === 'agent/inbox/claimed')
    const assistant = events.filter((event) => event.type === 'assistant/message')
    const turnEnds = events.filter((event) => event.type === 'turn/end')

    let inbox: RecordFacts['inbox'] = null
    try {
      const state = this.inboxState(id)
      inbox = {
        nextTurn: summarize(state['next-turn']),
        nextStep: summarize(state['next-step']),
      }
    } catch {
      inbox = null
    }

    return {
      available: true,
      reason: null,
      detail: null,
      sessionId: id,
      headSeq: head,
      capturedFromSeq: firstSeq,
      capturedThroughSeq: events.length === 0 ? null : events[events.length - 1].seq,
      truncated: firstSeq > 0,
      events,
      userMessages,
      claimed,
      assistant,
      turnEnds,
      inbox,
    }
  }

  /**
   * Runtime `agent/inbox/claimed` feed (PoC): proves the dispatched message was
   * claimed by a turn, with its own provenance. Subscribe implicitly on read.
   */
  pocClaimFeed(sessionId?: string, clear?: boolean): { subscribed: boolean; claims: ClaimFact[] } {
    this.assertPocEnabled()
    this.subscribeClaims()
    const filter = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
    const claims = filter === null ? [...this.claims] : this.claims.filter((claim) => claim.sessionId === filter)
    if (clear === true) this.claims = []
    return { subscribed: this.claimsSubscribed, claims }
  }

  private subscribeClaims(): void {
    if (this.claimsSubscribed) return
    try {
      this.ctx.on('agent/inbox/claimed', (payload: any) => {
        try {
          const message = payload?.message ?? {}
          const source = message?.source ?? {}
          const agent = payload?.agent
          this.claims.push({
            sessionId: agent?.session?.header?.id ?? agent?.id ?? null,
            messageId: String(message?.id ?? ''),
            sourceKind: String(source?.kind ?? 'unknown'),
            actionId: typeof source?.actionId === 'string' ? source.actionId : null,
            turn: Number.isFinite(payload?.turn) ? Number(payload.turn) : null,
            at: new Date().toISOString(),
          })
          if (this.claims.length > 200) this.claims.splice(0, this.claims.length - 200)
        } catch {
          /* a capture failure must never break the Agent event bus */
        }
      })
      this.claimsSubscribed = true
    } catch {
      this.claimsSubscribed = false
    }
  }

  private requireHost(): any {
    if (!this.host) throw new Error('boop: host sessions/projections are not available yet')
    return this.host
  }

  private assertPocEnabled(): void {
    if (!apiConfig.pocEnabled) throw new Error('boop: PoC endpoints are disabled for this profile')
  }

  private inboxState(sessionId: string): Record<string, unknown[]> {
    const session = this.requireHost().sessions.get(sessionId)
    if (!session) throw new Error(`boop: unknown synthetic session ${JSON.stringify(sessionId)}`)
    const state = this.requireHost().sessionProjections.stateOf(session, 'inbox')
    if (!state) throw new Error('boop: inbox projection unavailable on this host')
    return state as Record<string, unknown[]>
  }

  private pendingMessages(sessionId: string): unknown[] {
    const state = this.inboxState(sessionId)
    return [...(state['next-step'] ?? []), ...(state['next-turn'] ?? [])]
  }
}

function summarize(messages: unknown[] | undefined): Array<{ id: string; sourceKind: string }> {
  return (messages ?? []).map((message) => {
    const record = message as { id?: unknown; source?: { kind?: unknown } }
    return { id: String(record?.id ?? ''), sourceKind: String(record?.source?.kind ?? 'unknown') }
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sessionIdOf(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('boop: a non-empty sessionId is required')
  return value
}

function emptyRecord(sessionId: string): RecordFacts {
  return {
    available: false,
    reason: null,
    detail: null,
    sessionId,
    headSeq: null,
    capturedFromSeq: null,
    capturedThroughSeq: null,
    truncated: false,
    events: [],
    userMessages: [],
    claimed: [],
    assistant: [],
    turnEnds: [],
    inbox: null,
  }
}

const TEXT_LIMIT = 400

function textOfContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    const record = block as { type?: unknown; text?: unknown }
    if (record?.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  if (parts.length === 0) return null
  const joined = parts.join('\n')
  return joined.length > TEXT_LIMIT ? `${joined.slice(0, TEXT_LIMIT)}…` : joined
}

function textOfReason(reason: unknown): string | null {
  const record = reason as { kind?: unknown; error?: { message?: unknown } }
  if (!record || typeof record !== 'object') return null
  const kind = typeof record.kind === 'string' ? record.kind : null
  const message = errorText(record.error?.message ?? '').trim()
  return message === '' ? kind : `${kind}: ${message}`
}

/**
 * Reduce one raw durable event to the facts reconciliation reads.
 *
 * rc.2.1 finding: `agent/inbox/claimed` is NOT a durable Session event — the
 * loop emits it on its dispatch bus only (`dispatch.emit`), while the durable
 * claim boundary is the removing `agent/inbox/spliced` event that precedes the
 * `user/message` append. Both are captured: the runtime claim by
 * `pocClaimFeed`, the durable boundary here.
 */
function summarizeEvent(event: Record<string, unknown>): DurableEventFacts {
  const type = String(event.type ?? '')
  const data = (event.data ?? {}) as Record<string, any>
  const base: DurableEventFacts = {
    seq: Number(event.seq),
    type,
    time: Number(event.time ?? 0),
    messageId: null,
    sourceKind: null,
    actionId: null,
    provider: null,
    model: null,
    text: null,
    turnEnd: null,
    turn: null,
    spliceTarget: null,
    insertedIds: null,
    removedCount: null,
  }
  switch (type) {
    case 'user/message': {
      const source = data.source as { kind?: unknown; actionId?: unknown } | undefined
      return {
        ...base,
        messageId: typeof data.id === 'string' ? data.id : null,
        sourceKind: typeof source?.kind === 'string' ? source.kind : null,
        actionId: typeof source?.actionId === 'string' ? source.actionId : null,
        text: textOfContent(data.content),
      }
    }
    case 'agent/inbox/claimed': {
      const message = (data.message ?? {}) as Record<string, any>
      const source = message.source as { kind?: unknown; actionId?: unknown } | undefined
      return {
        ...base,
        messageId: typeof message.id === 'string' ? message.id : null,
        sourceKind: typeof source?.kind === 'string' ? source.kind : null,
        actionId: typeof source?.actionId === 'string' ? source.actionId : null,
        text: textOfContent(message.content),
        turn: Number.isFinite(data.turn) ? Number(data.turn) : null,
      }
    }
    case 'assistant/message': {
      const message = (data.message ?? {}) as Record<string, any>
      const source = message.source as { kind?: unknown; provider?: unknown; model?: unknown } | undefined
      return {
        ...base,
        messageId: typeof message.id === 'string' ? message.id : null,
        sourceKind: typeof source?.kind === 'string' ? source.kind : null,
        provider: typeof source?.provider === 'string' ? source.provider : null,
        model: typeof source?.model === 'string' ? source.model : null,
        text: textOfContent(message.content),
        turn: Number.isFinite(data.turn) ? Number(data.turn) : null,
      }
    }
    case 'turn/end':
      return { ...base, turnEnd: textOfReason(data.reason), turn: Number.isFinite(data.turn) ? Number(data.turn) : null }
    case 'turn/start':
      return { ...base, turn: Number.isFinite(data.turn) ? Number(data.turn) : null }
    case 'agent/inbox/spliced': {
      const inserted = Array.isArray(data.inserted) ? data.inserted : []
      const ids = inserted.map((message: Record<string, unknown>) => String(message?.id ?? '')).filter(Boolean)
      return {
        ...base,
        spliceTarget: typeof data.target === 'string' ? data.target : null,
        insertedIds: ids,
        removedCount: Number.isFinite(data.removedCount) ? Number(data.removedCount) : 0,
        text: `${String(data.target ?? '')}:${ids.join(',')}`,
      }
    }
    case 'error':
    case 'session/error':
      return { ...base, text: errorText(data.error?.message ?? data.message ?? '') }
    default:
      return base
  }
}

export const PRODUCTION_API_METHODS = [
  'bootstrap',
  'mainSession',
  'sources',
  'initPlan',
  'initApply',
  'observeSources',
] as const

export const POC_API_METHODS = [
  'pocSeedInbox',
  'pocInbox',
  'pocGateDecision',
  'pocGateStatus',
  'pocRelease',
  'pocResolveAgent',
  'pocDispatch',
  'pocReconcile',
  'pocSessionRecord',
  'pocClaimFeed',
] as const

const registeredPocApiMethods = new Set<string>()

/** Publish the PoC remote methods. A normal install never calls this. */
export function registerPocApiMethods(): void {
  for (const method of POC_API_METHODS) {
    if (registeredPocApiMethods.has(method)) continue
    remote(method)(BoopApi.prototype)
    registeredPocApiMethods.add(method)
  }
}

for (const method of PRODUCTION_API_METHODS) {
  remote(method)(BoopApi.prototype)
}

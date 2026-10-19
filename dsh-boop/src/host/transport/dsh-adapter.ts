/**
 * rc.2 host adapter (03§04 适配矩阵, E02-03 implementation).
 *
 * Verified facts this adapter relies on (all observed on the installed
 * payload, see docs/development/STATUS.md):
 *  - `SessionController.prompt()` hardcodes `source: { kind: 'user' }`, so it
 *    CANNOT carry a BOOP proxy source. BOOP therefore delivers through the
 *    Agent's own `followup`/`steer` with a host-minted message, which keeps
 *    agent provenance and never impersonates a human prompt;
 *  - `SessionController.resolveAgent(sessionId)` creates or resumes the Agent
 *    for a Session without requiring a turn to run;
 *  - the Agent inbox is a durable projection, so every delivery is
 *    reconcilable by message id after a restart.
 */

import {
  buildProxyMessage,
  isBoopMessage,
  PROXY_SOURCE_KIND,
  type CommandEnvelope,
} from './command-envelope.ts'

/**
 * Build the user-role message the Agent's own inbox accepts.
 *
 * E02-03 real-dispatch finding: this adapter MUST NOT import
 * `@deepseek-ai/dsh-llm` for `createUserMessage`. The host package is not a
 * declared peer of this plugin, so a linked (or pnpm-installed) profile cannot
 * resolve it from this package's location and the whole `boop-api` row fails to
 * import — every BOOP endpoint 404s. The helper is also the wrong semantic: it
 * overwrites a supplied `id` with a fresh UUID, which would break the
 * reconciliation contract below (the dispatched id would never appear in the
 * durable log).
 *
 * What the host helper does at runtime is exactly this: attach `role`, then
 * detach + freeze the message (`deepFreeze(structuredClone(...))`). The message
 * id is the HOST-MINTED envelope id, so dispatch receipts and the durable
 * `agent/inbox/claimed` event carry the same key.
 */
function createProxyUserMessage(input: {
  id: string
  content: unknown
  source: unknown
}): { id: string; role: 'user'; content: unknown; source: unknown } {
  const message = structuredClone({
    id: input.id,
    role: 'user' as const,
    content: input.content,
    source: input.source,
  })
  return Object.freeze(message) as { id: string; role: 'user'; content: unknown; source: unknown }
}

export interface SessionSummary {
  sessionId: string
  workspaceId: string | null
  title: string | null
  running: boolean
  updatedAt: string | null
}

export interface DispatchResult {
  messageId: string
  accepted: boolean
  mode: 'queue' | 'steer'
  /**
   * true = the exact message id was already pending in the target inbox, so the
   * Agent was NOT asked again. A duplicate delivery never appends a second copy
   * and never becomes a second execution (AT-13, dispatcher-layer idempotency).
   */
  duplicate?: boolean
}

/* ── durable reconciliation evidence (E02-03 / AT-13) ─────────────────── */

/** One durable `user/message` (a claimed BOOP command appears here after the drain). */
export interface DurableUserMessage {
  seq: number
  timeMs: number
  messageId: string
  sourceKind: string | null
  actionId: string | null
}

/** One durable `agent/inbox/spliced` boundary (insert into, or drain from, the inbox). */
export interface DurableSplice {
  seq: number
  timeMs: number
  target: string
  insertedIds: string[]
  removedCount: number
}

/**
 * What the DURABLE Session log proves about a delivery attempt.
 *
 * `agent/inbox/claimed` is NOT durable on rc.2.1 (it is only emitted on the
 * Agent dispatch bus), so reconciliation only trusts the durable log + the
 * rebuilt inbox projection. The result is deliberately tri-state:
 * positive evidence (`delivered`) is always usable, while ABSENCE of evidence is
 * only usable after a CLEAN restart (`clean`), because an unclean SIGKILL can
 * lose a not-yet-flushed durable tail (see E07-01 evidence).
 */
export interface DurableTrace {
  sessionId: string
  available: boolean
  reason: string | null
  detail: string | null
  sessionExists: boolean
  headSeq: number | null
  headTimeMs: number | null
  /** Lower time bound used when selecting candidates (ms since epoch). */
  sinceMs: number | null
  /** Number of durable events that could carry a delivery record. */
  candidateEvents: number
  /** true = the raw-read budget was hit, so absence is NOT a proof. */
  truncated: boolean
  userMessages: DurableUserMessage[]
  splices: DurableSplice[]
  /** Message ids the rebuilt inbox projection still holds. */
  pendingInboxIds: string[]
  inboxObservable: boolean
  inboxReason: string | null
}

export interface DurableTraceOptions {
  /** Only durable events with `time >= sinceMs` can carry this delivery. */
  sinceMs?: number | null
  /** Bound on raw `readEvent` reads (index reads are body-free). */
  maxRawReads?: number
  /** True when the previous Host stopped gracefully (enables "not delivered"). */
  clean?: boolean
}

export interface DshAdapterOptions {
  ctx: any
  /** Session ids this process may touch (the data domain's authorized set). */
  authorize?: (sessionId: string) => boolean
}

export class DshAdapter {
  private readonly ctx: any
  private readonly authorize: (sessionId: string) => boolean

  constructor(options: DshAdapterOptions) {
    this.ctx = options.ctx
    this.authorize = options.authorize ?? (() => true)
  }

  /** Sessions visible to the operator, cold-safe (no Agent is created). */
  listSessions(): SessionSummary[] {
    const query = this.ctx.reflect?.get?.('sessionQuery', false)
    const list = query?.listSessions
    if (typeof list !== 'function') return []
    const rows = list.call(query) ?? []
    return rows.map((row: Record<string, unknown>) => ({
      sessionId: String(row.id ?? row.sessionId ?? ''),
      workspaceId: row.workspaceId === null || row.workspaceId === undefined ? null : String(row.workspaceId),
      title: row.title === null || row.title === undefined ? null : String(row.title),
      running: Boolean(row.running),
      updatedAt: row.updatedAt === null || row.updatedAt === undefined ? null : String(row.updatedAt),
    }))
  }

  /**
   * Create or resume the Agent for one Session, without running a turn.
   *
   * @returns the live Agent, or null when this composition/Session cannot
   * resolve one. Never a result-union wrapper: rc.2.1's
   * `SessionController.resolveAgent()` answers `{ agent } | { error }` (the
   * typert lookup unwraps it), so an adapter that assigned that wrapper to
   * `target` would deliver nothing and report a false success.
   */
  async resolveAgent(sessionId: string): Promise<any | null> {
    if (!this.authorize(sessionId)) return null
    const controller = this.ctx.reflect?.get?.('sessionController', false)
    if (controller && typeof controller.resolveAgent === 'function') {
      const found = await controller.resolveAgent(sessionId)
      if (found && typeof found === 'object') {
        if ('agent' in found) return (found as { agent?: unknown }).agent ?? null
        if ('error' in found) return null
      }
      return found ?? null
    }
    const agents = this.ctx.reflect?.get?.('agents', false)
    return agents?.get?.(sessionId) ?? null
  }

  /** Resolve diagnostics for the PoC surface (error text, agent identity, cwd). */
  async inspectAgent(sessionId: string): Promise<{
    resolved: boolean
    agentId: string | null
    cwd: string | null
    error: string | null
  }> {
    const controller = this.ctx.reflect?.get?.('sessionController', false)
    if (!controller || typeof controller.resolveAgent !== 'function') {
      const live = this.ctx.reflect?.get?.('agents', false)?.get?.(sessionId) ?? null
      return live
        ? { resolved: true, agentId: idOf(live), cwd: cwdOf(live), error: null }
        : { resolved: false, agentId: null, cwd: null, error: 'this host exposes no sessionController' }
    }
    try {
      const found = await controller.resolveAgent(sessionId)
      if (found && typeof found === 'object' && 'error' in found) {
        const error = (found as { error?: unknown }).error
        return {
          resolved: false,
          agentId: null,
          cwd: null,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      const agent = found && typeof found === 'object' && 'agent' in found ? (found as { agent?: any }).agent : found
      return agent
        ? { resolved: true, agentId: idOf(agent), cwd: cwdOf(agent), error: null }
        : { resolved: false, agentId: null, cwd: null, error: 'resolveAgent returned no agent' }
    } catch (error) {
      return { resolved: false, agentId: null, cwd: null, error: errorText(error) }
    }
  }

  /**
   * Deliver one BOOP command to an ORIGINAL Session.
   *
   * The message carries a BOOP source envelope, so it is never confused with a
   * human prompt in the UI, the durable log, or the projections.
   */
  async enqueueProxy(
    input: { envelope: CommandEnvelope; targetSessionId: string },
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    const { envelope, targetSessionId } = input
    if (!this.authorize(targetSessionId)) return { messageId: envelope.messageId, accepted: false, mode: envelope.mode }
    // AT-13 layer-2 guard: a message id already pending in the durable inbox is
    // never re-inserted. The dispatcher is layer-1 (it returns `duplicate` before
    // it ever reaches this adapter); this guard covers direct adapter callers.
    const pending = this.pendingMessages(targetSessionId) as Array<{ id?: unknown }>
    if (pending.some((message) => message?.id === envelope.messageId)) {
      return { messageId: envelope.messageId, accepted: true, mode: envelope.mode, duplicate: true }
    }
    const target = await this.resolveAgent(targetSessionId)
    if (!target) return { messageId: envelope.messageId, accepted: false, mode: envelope.mode }
    const { message } = buildProxyMessage({ envelope, targetSessionId })
    // Host-minted id wins: the durable log, the inbox claim and the dispatch
    // receipt must all name the same message.
    const created = createProxyUserMessage({
      id: envelope.messageId,
      content: message.content,
      source: message.source,
    })
    if (signal?.aborted) return { messageId: envelope.messageId, accepted: false, mode: envelope.mode }
    if (envelope.mode === 'steer') target.steer(created)
    else target.followup(created)
    return { messageId: created.id, accepted: true, mode: envelope.mode }
  }

  /** The Agent's pending inbox, as the durable projection sees it. */
  pendingMessages(sessionId: string): unknown[] {
    const sessions = this.ctx.reflect?.get?.('sessions', false)
    const projections = this.ctx.reflect?.get?.('sessionProjections', false)
    if (!sessions || !projections) return []
    const session = sessions.get?.(sessionId)
    if (!session) return []
    const state = projections.stateOf?.(session, 'inbox')
    if (!state) return []
    return [...(state['next-step'] ?? []), ...(state['next-turn'] ?? [])]
  }

  /** Pending BOOP commands for one Session, with their durable identity. */
  pendingProxyCommands(sessionId: string, knownMessageIds: ReadonlySet<string>): Array<{ id: string; actionId: string }> {
    const found: Array<{ id: string; actionId: string }> = []
    for (const message of this.pendingMessages(sessionId)) {
      if (!isBoopMessage(message, knownMessageIds)) continue
      const record = message as { id?: string; source?: { actionId?: string } }
      found.push({ id: String(record.id ?? ''), actionId: String(record.source?.actionId ?? '') })
    }
    return found
  }

  /**
   * Durable reconciliation evidence for one Session (AT-13).
   *
   * Read-only and bounded:
   *  - `sessionQuery.listEvents` is a body-free index, cheap to read;
   *  - raw `readEvent` windows are only opened for `user/message` and
   *    `agent/inbox/spliced` events at/after `sinceMs` (the dispatch instant),
   *    capped by `maxRawReads`;
   *  - the rebuilt inbox projection is read for still-pending message ids.
   *
   * Nothing here writes, wakes an Agent or resumes a Session. `agent/inbox/claimed`
   * is intentionally NOT used: rc.2.1 only emits it on the runtime dispatch bus.
   */
  async readDurableTrace(sessionId: string, options: DurableTraceOptions = {}): Promise<DurableTrace> {
    const maxRawReads = Math.max(1, Math.min(500, Math.trunc(options.maxRawReads ?? 200)))
    const sinceMs = typeof options.sinceMs === 'number' && Number.isFinite(options.sinceMs) ? options.sinceMs : null
    const trace: DurableTrace = {
      sessionId,
      available: false,
      reason: null,
      detail: null,
      sessionExists: false,
      headSeq: null,
      headTimeMs: null,
      sinceMs,
      candidateEvents: 0,
      truncated: false,
      userMessages: [],
      splices: [],
      pendingInboxIds: [],
      inboxObservable: false,
      inboxReason: null,
    }
    const query = this.ctx.reflect?.get?.('sessionQuery', false)
    if (!query || typeof query.listEvents !== 'function' || typeof query.readEvent !== 'function') {
      return { ...trace, reason: 'session-query-unavailable' }
    }

    // Does the Session exist at all? (cold-safe list; no Agent is created)
    try {
      const sessions = (await query.listSessions()) ?? []
      trace.sessionExists = (sessions as Array<Record<string, unknown>>).some((row) => {
        const header = (row?.header ?? {}) as Record<string, unknown>
        return String(header.id ?? row?.id ?? row?.sessionId ?? '') === sessionId
      })
    } catch {
      return { ...trace, reason: 'session-list-not-readable' }
    }

    let index: Array<{ seq: number; type: string; time: number }>
    try {
      const records = (await query.listEvents(sessionId)) ?? []
      index = (records as Array<Record<string, unknown>>).map((row) => ({
        seq: Number(row.seq),
        type: String(row.type ?? ''),
        time: Number(row.time ?? 0),
      }))
    } catch (error) {
      return { ...trace, reason: 'session-not-readable', detail: errorText(error) }
    }
    trace.available = true
    if (index.length > 0) {
      trace.headSeq = index[index.length - 1].seq
      trace.headTimeMs = index[index.length - 1].time
    }

    // Only these durable events can carry a delivery record.
    const candidates = index
      .filter((event) => event.type === 'user/message' || event.type === 'agent/inbox/spliced')
      .filter((event) => sinceMs === null || event.time >= sinceMs)
      .sort((left, right) => left.seq - right.seq)
    trace.candidateEvents = candidates.length
    const toRead = candidates.slice(0, maxRawReads)
    trace.truncated = candidates.length > toRead.length
    for (const candidate of toRead) {
      let raw: Record<string, unknown> | null = null
      try {
        const window = await query.readEvent({ sessionId, seq: candidate.seq, before: 0, after: 0 })
        raw = (window?.events ?? []).find((event: Record<string, unknown>) => Number(event?.seq) === candidate.seq) ?? null
      } catch {
        // A failed raw read makes absence unusable (truncated) but never invents a fact.
        trace.truncated = true
        continue
      }
      if (raw === null) {
        trace.truncated = true
        continue
      }
      const data = (raw.data ?? {}) as Record<string, unknown>
      if (candidate.type === 'user/message') {
        const source = (data.source ?? {}) as Record<string, unknown>
        trace.userMessages.push({
          seq: candidate.seq,
          timeMs: candidate.time,
          messageId: typeof data.id === 'string' ? data.id : '',
          sourceKind: typeof source.kind === 'string' ? source.kind : null,
          actionId: typeof source.actionId === 'string' ? source.actionId : null,
        })
      } else {
        const inserted = Array.isArray(data.inserted) ? (data.inserted as Array<Record<string, unknown>>) : []
        trace.splices.push({
          seq: candidate.seq,
          timeMs: candidate.time,
          target: typeof data.target === 'string' ? data.target : '',
          insertedIds: inserted.map((message) => String(message?.id ?? '')).filter((id) => id !== ''),
          removedCount: Number.isFinite(data.removedCount) ? Number(data.removedCount) : 0,
        })
      }
    }

    // The rebuilt inbox projection: a still-pending message id proves receipt.
    const sessionsService = this.ctx.reflect?.get?.('sessions', false)
    const projections = this.ctx.reflect?.get?.('sessionProjections', false)
    if (!sessionsService || !projections) {
      trace.inboxReason = 'inbox-projection-unavailable'
      return trace
    }
    try {
      const session = sessionsService.get?.(sessionId)
      if (!session) {
        trace.inboxReason = 'session-not-live'
        return trace
      }
      const state = projections.stateOf?.(session, 'inbox')
      if (!state || typeof state !== 'object') {
        trace.inboxReason = 'inbox-projection-unavailable'
        return trace
      }
      const nextTurn = Array.isArray((state as Record<string, unknown[]>)['next-turn'])
        ? ((state as Record<string, unknown[]>)['next-turn'] as Array<Record<string, unknown>>)
        : []
      const nextStep = Array.isArray((state as Record<string, unknown[]>)['next-step'])
        ? ((state as Record<string, unknown[]>)['next-step'] as Array<Record<string, unknown>>)
        : []
      trace.pendingInboxIds = [...nextTurn, ...nextStep]
        .map((message) => String(message?.id ?? ''))
        .filter((id) => id !== '')
      trace.inboxObservable = true
    } catch (error) {
      trace.inboxReason = `inbox-projection-read-failed: ${errorText(error)}`
    }
    return trace
  }

  /** Ask the Agent to flush its durable log; used before reconciliation reads. */
  async flush(sessionId: string): Promise<void> {
    const session = this.ctx.reflect?.get?.('sessions', false)?.get?.(sessionId)
    const persistence = this.ctx.reflect?.get?.('sessionPersistence', false)
    if (session && persistence && typeof persistence.flush === 'function') {
      await persistence.flush(session)
      return
    }
    const agent = await this.resolveAgent(sessionId)
    await agent?.whenIdle?.()
  }

  /**
   * Stop only work BOOP owns. A cancel with no BOOP provenance is refused:
   * BOOP never stops a human's turn (03§12).
   */
  async cancelOwned(input: {
    sessionId: string
    actionId: string
    knownMessageIds: ReadonlySet<string>
  }): Promise<{ requested: boolean; settled: boolean }> {
    const pending = this.pendingProxyCommands(input.sessionId, input.knownMessageIds)
    const owns = pending.some((row) => row.actionId === input.actionId)
    if (!owns) return { requested: false, settled: false }
    const agent = await this.resolveAgent(input.sessionId)
    if (!agent) return { requested: false, settled: false }
    agent.cancel({ kind: 'user' })
    return { requested: true, settled: true }
  }

  sourceKind(): string {
    return PROXY_SOURCE_KIND
  }
}

function idOf(agent: any): string | null {
  const id = agent?.id
  return typeof id === 'string' ? id : null
}

function cwdOf(agent: any): string | null {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' ? cwd : null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * BOOP scheduler host row `boop-scheduler` (E05-01, host half).
 *
 * An unambiguous Cordis function plugin (`name` / `inject` / `apply`) mounted
 * from `cordis.patch.yml` as `boop-scheduler`, so the foreground/background
 * scheduler, the read-only patrol and the native-automation binding can be
 * composed, disabled or tested independently of the other BOOP rows.
 *
 * It registers the `boopScheduler` Typert Remote service over the framework-free
 * core in `scheduler.ts` / `patrol.ts`, and wires it to the REAL Host:
 *
 *  - P1 wiring: a native `user/message` event puts the scheduler in foreground
 *    (no NEW background batch starts); `turn/end` returns it to idle;
 *  - P3 batches: `MemoryExtractor` (E03-02) over the real observation plane and
 *    the real `MemoryCommitter`, under the ONE shared `ModelPermits`;
 *  - patrol: read-only projections of lease / cursors / approvals / outbox /
 *    recovery gate / native binding — no model, no write, no auto-recovery;
 *  - native automation: BOOP's user-visible active-rhythm task bound to the
 *    native `schedule` service when it is mounted; unavailable is reported
 *    honestly when it is not (03§77: never fake a side-channel write timer).
 *
 * Wire shape (rc.2.1 SRC convention): every method takes ONE `request` object;
 * responses are SINGLE-LAYER fact objects inside `result.value`. Business
 * refusals stay in the value (`ok:false` + `code`), never as transport errors.
 *
 * `pocRunBackground` exists ONLY for opt-in evidence runs in isolated profiles
 * (`pocEnabled: true`); the shipped profile keeps it closed and every ordinary
 * control/read endpoint works with write mode OFF (pause/cancel are safety acts).
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { remote } from './remote.ts'
import { pocRequested } from './poc-switch.ts'
import { MemoryCommitter } from './memory/committer.ts'
import { MemoryExtractor } from './memory/extractor.ts'
import { LedgerCursorStore } from './observe/observer.ts'
import { ModelPermits } from './model/permits.ts'
import { createQwenClient, NO_CREDENTIAL } from './model/qwen-client.ts'
import {
  BoopScheduler,
  NativeAutomationBinding,
  SCHEDULER_DEFAULTS,
  SCHEDULER_ENDPOINTS,
  SCHEDULER_POC_ENDPOINTS,
  SCHEDULER_READ_ENDPOINTS,
  SCHEDULER_REMOTE_NAMESPACE,
  SCHEDULER_ROW_ID,
  normalizeControlScope,
  type BatchOutcome,
  type ControlResultFacts,
  type NativeBindingStatus,
  type NativeSchedulePort,
  type NativeScheduleTask,
  type SchedulerAuditEvent,
  type SchedulerStatusFacts,
} from './scheduler.ts'
import {
  PATROL_DEFAULT_INTERVAL_MS,
  runPatrol,
  type PatrolFacts,
  type PatrolPorts,
} from './patrol.ts'

export const name = 'boop-scheduler'

/** `boop` carries the ledger, gate and write-mode; the gateway routes Remote methods. */
export const inject = ['boop', 'typertGateway']

export interface BoopSchedulerModelRoute {
  providerId: string
  modelId: string
  baseUrl: string
  /** Credential REFERENCE only; `none` for the user's keyless self-hosted service. */
  credentialRef?: string
  contextWindowTokens: number
  declaredContext?: string
  quantization?: string
}

export interface BoopSchedulerConfig {
  /** Set false only in isolated diagnostics; the shipped default registers the row. */
  enabled?: boolean
  /** Opt-in background batch execution (isolated evidence profiles only). */
  pocEnabled?: boolean
  mergeWindowMs?: number
  patrolIntervalMs?: number
  /** Set false to keep a deterministic test host free of the patrol timer. */
  patrolTimer?: boolean
  softTimeoutMs?: number
  maxJobAttempts?: number
  /** Native automation task time (daily wall-clock). */
  dailyTime?: string
  timeZone?: string
  /** Background model route; absent → background batches report unavailable. */
  modelRoute?: BoopSchedulerModelRoute
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

function writeModeFacts(ctx: any): { enabled: boolean; blockedByGates: string[] } | null {
  try {
    const status = ctx.boop?.writeMode?.()
    if (status && typeof status === 'object') {
      return {
        enabled: status.enabled === true,
        blockedByGates: Array.isArray(status.blockedByGates) ? status.blockedByGates.map(String) : [],
      }
    }
    const enabled = ctx.boop?.isWriteModeEnabled?.() === true
    return { enabled, blockedByGates: [] }
  } catch {
    return null
  }
}

function mainSessionIdOf(ctx: any): string | null {
  try {
    const storage = storageOf(ctx)
    const scopeId = scopeIdOf(ctx)
    if (!storage?.repo || scopeId === null) return null
    const scope = storage.repo.getScope(scopeId)
    return scope?.mainSessionId === null || scope?.mainSessionId === undefined ? null : String(scope.mainSessionId)
  } catch {
    return null
  }
}

function nativeSchedulePortOf(ctx: any): NativeSchedulePort | null {
  try {
    const service = ctx.reflect?.get?.('schedule', false)
    if (!service || typeof service.create !== 'function' || typeof service.delete !== 'function') return null
    return {
      available: () => true,
      async create(sessionId: string, request: Record<string, unknown>): Promise<NativeScheduleTask> {
        const record = await service.create(sessionId, request)
        return {
          id: String(record?.id ?? ''),
          title: typeof record?.title === 'string' ? record.title : undefined,
          kind: typeof record?.kind === 'string' ? record.kind : undefined,
          scheduledAt: typeof record?.scheduledAt === 'string' ? record.scheduledAt : undefined,
          state: typeof record?.state === 'string' ? record.state : undefined,
        }
      },
      async delete(request: { sessionId: string; id: string }) {
        const result = await service.delete(request)
        return {
          ...(typeof result?.id === 'string' ? { id: result.id } : {}),
          ...(typeof result?.deleted === 'boolean' ? { deleted: result.deleted } : {}),
          ...(typeof result?.code === 'string' ? { code: result.code } : {}),
        }
      },
      async list(request: { sessionId: string }) {
        const rows = await service.list(request)
        return (Array.isArray(rows) ? rows : []).map((row: Record<string, unknown>) => ({
          id: String(row?.id ?? ''),
          title: typeof row?.title === 'string' ? row.title : undefined,
          kind: typeof row?.kind === 'string' ? row.kind : undefined,
          scheduledAt: typeof row?.scheduledAt === 'string' ? row.scheduledAt : undefined,
          state: typeof row?.state === 'string' ? row.state : undefined,
        }))
      },
    }
  } catch {
    return null
  }
}

/* ── audit sink: BOOP ledger with an honest memory fallback ──────────── */

class SchedulerAuditSink {
  private readonly ctx: any
  private readonly memory: SchedulerAuditEvent[] = []
  private ledgerAvailable = false

  constructor(ctx: any) {
    this.ctx = ctx
  }

  sink(): string {
    try {
      const storage = storageOf(this.ctx)
      const scopeId = scopeIdOf(this.ctx)
      if (storage?.repo && scopeId !== null && typeof storage.repo.audit === 'function') {
        this.ledgerAvailable = true
        return 'ledger'
      }
    } catch {
      /* fall through */
    }
    this.ledgerAvailable = false
    return 'memory'
  }

  record(event: SchedulerAuditEvent): { sink: string; persisted: boolean } {
    try {
      const storage = storageOf(this.ctx)
      const scopeId = scopeIdOf(this.ctx)
      if (storage?.repo && scopeId !== null && typeof storage.repo.audit === 'function') {
        storage.repo.audit(scopeId, event.kind, event.jobId ?? null, 'system', event.detail ?? null)
        this.ledgerAvailable = true
        return { sink: 'ledger', persisted: true }
      }
    } catch {
      /* memory fallback below */
    }
    this.ledgerAvailable = false
    this.memory.push(event)
    if (this.memory.length > 100) this.memory.splice(0, this.memory.length - 100)
    return { sink: 'memory', persisted: false }
  }

  tail(): SchedulerAuditEvent[] {
    return [...this.memory]
  }
}

/* ── patrol ports over the real Host ─────────────────────────────────── */

function patrolPortsOf(
  ctx: any,
  binding: NativeAutomationBinding,
  modelRoute: BoopSchedulerModelRoute | null,
  now: () => number,
): PatrolPorts {
  const read = (sql: string, ...params: unknown[]): unknown => {
    const storage = storageOf(ctx)
    const db = storage?.db?.db
    if (!db) throw new Error('ledger unavailable')
    return db.prepare(sql).get(...params)
  }
  const readAll = (sql: string, ...params: unknown[]): Array<Record<string, unknown>> => {
    const storage = storageOf(ctx)
    const db = storage?.db?.db
    if (!db) throw new Error('ledger unavailable')
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>
  }
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }
  return {
    now,
    lease: () =>
      safe(() => {
        const facts = ctx.boop?.state?.()?.storage ?? null
        if (!facts) return null
        const scopeId = scopeIdOf(ctx)
        const row = scopeId === null ? null : (read('SELECT holder, fencing_token, expires_at FROM runtime_lease WHERE scope_id = ?', scopeId) as
          | { holder?: string; fencing_token?: number; expires_at?: string }
          | undefined)
        // The ledger stores the lease expiry as epoch-milliseconds TEXT (the
        // LeaseManager's own encoding), not ISO; parse both so a live lease is
        // never reported as lost just because of the encoding.
        const rawExpires = row?.expires_at
        const expiresAt =
          rawExpires === undefined || rawExpires === null
            ? null
            : /^\d+$/u.test(String(rawExpires))
              ? Number(rawExpires)
              : Date.parse(String(rawExpires))
        const live = expiresAt === null ? facts.lease?.held === true : Number.isFinite(expiresAt) && (expiresAt as number) > now()
        return {
          held: facts.lease?.held === true && live,
          holder: String(row?.holder ?? facts.lease?.holder ?? ''),
          fencingToken: Number(row?.fencing_token ?? facts.lease?.fencingToken ?? 0),
          released: facts.lease?.released === true,
        }
      }, null),
    cursors: () =>
      safe(() => {
        const storage = storageOf(ctx)
        const scopeId = scopeIdOf(ctx)
        if (!storage?.repo || scopeId === null) return null
        return storage.repo.cursors(scopeId) as Array<{ sessionId: string; sourceGeneration: string; throughSeq: number; state: string }>
      }, null),
    approvals: () =>
      safe(() => {
        const scopeId = scopeIdOf(ctx)
        if (scopeId === null) return null
        const total = Number((read('SELECT count(*) c FROM approval WHERE scope_id = ?', scopeId) as { c: number }).c)
        const pending = Number(
          (read("SELECT count(*) c FROM approval WHERE scope_id = ? AND status = 'pending'", scopeId) as { c: number }).c,
        )
        const expiredPending = Number(
          (read(
            "SELECT count(*) c FROM approval WHERE scope_id = ? AND status = 'pending' AND expires_at < ?",
            scopeId,
            new Date(now()).toISOString(),
          ) as { c: number }).c,
        )
        const examples = readAll(
          'SELECT id, status, expires_at FROM approval WHERE scope_id = ? ORDER BY expires_at ASC, id ASC LIMIT 5',
          scopeId,
        ).map((row) => ({ id: String(row.id ?? ''), status: String(row.status ?? ''), expiresAt: row.expires_at === null ? null : String(row.expires_at) }))
        return { total, pending, expiredPending, examples }
      }, null),
    outbox: () =>
      safe(() => {
        const scopeId = scopeIdOf(ctx)
        if (scopeId === null) return null
        const rows = readAll('SELECT state, count(*) c FROM command_outbox WHERE scope_id = ? GROUP BY state', scopeId)
        const countOf = (state: string): number => Number(rows.find((row) => row.state === state)?.c ?? 0)
        const examples = readAll(
          "SELECT action_id, state FROM command_outbox WHERE scope_id = ? AND state = 'unknown' ORDER BY action_id LIMIT 5",
          scopeId,
        ).map((row) => ({ actionId: String(row.action_id ?? ''), state: String(row.state ?? '') }))
        return {
          unknown: countOf('unknown'),
          sending: countOf('sending'),
          blocked: countOf('blocked'),
          prepared: countOf('prepared'),
          examples,
        }
      }, null),
    gate: () =>
      safe(() => {
        const gate = ctx.boop?.gate?.()
        if (!gate || typeof gate.list !== 'function' || typeof gate.isArmed !== 'function') return null
        const entries = (gate.list() as Array<Record<string, unknown>>).map((entry) => ({
          messageId: String(entry?.messageId ?? ''),
          actionId: String(entry?.actionId ?? ''),
          sessionId: String(entry?.sessionId ?? ''),
          state: String(entry?.state ?? ''),
        }))
        return {
          armed: gate.isArmed() === true,
          entries: entries.length,
          blocked: entries.filter((entry) => entry.state !== 'released').length,
          released: entries.filter((entry) => entry.state === 'released').length,
          examples: entries.slice(0, 5),
        }
      }, null),
    native: () => binding.status(),
    modelRoute: () => (modelRoute === null ? null : { providerId: modelRoute.providerId, modelId: modelRoute.modelId }),
    writeMode: () => writeModeFacts(ctx),
  }
}

/* ── status facts ─────────────────────────────────────────────────────── */

export interface SchedulerStatusResponse {
  schemaVersion: 1
  row: string
  remoteService: string
  at: string
  writeMode: { enabled: boolean; blockedByGates: string[] } | null
  gates: Record<string, string>
  background: {
    pocEnabled: boolean
    modelRoute: { providerId: string; modelId: string; baseUrl: string; contextWindowTokens: number; credential: string } | null
    note: string
  }
  scheduler: SchedulerStatusFacts
  patrol: PatrolFacts | null
  native: NativeBindingStatus
  endpoints: readonly string[]
  pocEndpoints: readonly string[]
  controlEndpoints: readonly string[]
  readEndpoints: readonly string[]
}

export type SchedulerControlResponse = ControlResultFacts & {
  writeMode: { enabled: boolean; blockedByGates: string[] } | null
  dispatch: 'gated (this row never dispatches)'
}

export interface PocRunBackgroundFacts {
  ok: boolean
  code?: string
  sessionId: string
  jobId: string | null
  state: 'completed' | 'timeout' | 'rejected'
  batch: BatchRecordLike | null
  modelCalls: number
  writeMode: { enabled: boolean; blockedByGates: string[] } | null
  note: string
}

export interface BatchRecordLike {
  jobId: string
  status: string
  reason: string | null
  elapsedMs: number
  applied: string[]
  watermark: { before: number; after: number } | null
  model: { providerId: string | null; modelId: string | null; attempts: number | null; elapsedMs: number | null }
}

/* ── the row runtime ──────────────────────────────────────────────────── */

interface SchedulerRuntime {
  config: BoopSchedulerConfig
  scheduler: BoopScheduler
  binding: NativeAutomationBinding
  auditSink: SchedulerAuditSink
  lastPatrol: PatrolFacts | null
  modelRoute: BoopSchedulerModelRoute | null
}

/* ── observation batch adapter (rc.2.1 host reader contract fix-up) ──── */

/**
 * The observation plane's `readBatch` requires CONTIGUOUS event records carrying
 * a `semantic` flag, but the rc.2.1 `HostSourceReader.listEvents` returns only
 * semantic documents (a filtered list) — a real Host Session would therefore
 * look like a permanent `READ_GAP`. This adapter reads the SAME read-only
 * `sessionQuery` plane correctly: the body-free index for sequence continuity
 * and one bounded raw window (`readEvent`) for text/provenance. It is read-only
 * against the user Session and writes only BOOP's own cursor.
 */
const BATCH_SEMANTIC_TYPES = new Set(['user/message', 'assistant/message', 'turn/end', 'notice', 'user/approval'])
const BATCH_WINDOW_MAX = 50

interface ObservationBatchRecord {
  seq: number
  type: string
  time: number
  semantic: boolean
  text?: string
  sourceKind?: string
}

function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
    .map((block) => String((block as { text?: unknown }).text ?? ''))
    .join('')
}

function summarizeObservationEvent(raw: Record<string, any>): ObservationBatchRecord {
  const type = String(raw.type ?? '')
  const data = (raw.data ?? {}) as Record<string, any>
  let text = ''
  let sourceKind: string | undefined
  if (type === 'user/message') {
    text = textOfBlocks(data.content)
    sourceKind = typeof data.source?.kind === 'string' ? data.source.kind : undefined
  } else if (type === 'assistant/message') {
    text = textOfBlocks(data.message?.content)
    sourceKind = typeof data.message?.source?.kind === 'string' ? data.message.source.kind : 'model'
  } else if (type === 'turn/end') {
    text = data.reason?.kind === 'error' ? String(data.reason?.error?.message ?? '') : ''
  }
  return {
    seq: Number(raw.seq),
    type,
    time: Number(raw.time ?? 0),
    semantic: BATCH_SEMANTIC_TYPES.has(type) && text.trim() !== '',
    ...(text.trim() === '' ? {} : { text }),
    ...(sourceKind === undefined ? {} : { sourceKind }),
  }
}

function createObservationBatch(ctx: any, cursors: LedgerCursorStore, scopeId: string): {
  readBatch(input: { sessionId: string; limit?: number }): Promise<{
    records: ObservationBatchRecord[]
    fromSeq: number
    throughSeq: number
    gap: boolean
  }>
  commitRead(input: { sessionId: string; throughSeq: number }): void
} {
  const cursorRows = () => cursors.all(scopeId)
  const latest = (sessionId: string): { throughSeq: number; sourceGeneration: string; state: string } | null => {
    const rows = cursorRows()
      .filter((row) => row.sessionId === sessionId)
      .sort((left, right) => (left.sourceGeneration < right.sourceGeneration ? 1 : -1))
    const head = rows[0]
    return head ? { throughSeq: head.throughSeq, sourceGeneration: head.sourceGeneration, state: head.state } : null
  }
  const write = (sessionId: string, sourceGeneration: string, throughSeq: number, state: string): void => {
    cursors.write({ scopeId, sessionId, sourceGeneration, throughSeq, state: state as never })
  }
  const query = () => {
    const service = ctx.reflect?.get?.('sessionQuery', false)
    if (!service || typeof service.listEvents !== 'function' || typeof service.readEvent !== 'function') {
      throw new Error('session query plane is unavailable')
    }
    return service
  }
  return {
    async readBatch(input) {
      const cursor = latest(input.sessionId)
      if (cursor === null) throw new Error('Session is not registered in BOOP observation; run discovery first')
      const limit = Math.max(1, input.limit ?? 200)
      const index = (await query().listEvents(input.sessionId)) ?? []
      const head = index.length === 0 ? cursor.throughSeq : Number(index[index.length - 1].seq)
      const fromSeq = cursor.throughSeq
      const endSeq = Math.min(head, fromSeq + Math.min(limit, BATCH_WINDOW_MAX))
      if (endSeq <= fromSeq) return { records: [], fromSeq, throughSeq: fromSeq, gap: false }
      const before = Math.max(0, endSeq - fromSeq - 1)
      const window = (await query().readEvent({ sessionId: input.sessionId, seq: endSeq, before, after: 0 })) ?? {}
      const raw = (Array.isArray(window.events) ? window.events : []) as Array<Record<string, any>>
      const inRange = raw.filter((event) => Number(event.seq) > fromSeq && Number(event.seq) <= endSeq)
      let expected = fromSeq + 1
      let gap = false
      for (const event of inRange) {
        if (Number(event.seq) !== expected) gap = true
        expected = Number(event.seq) + 1
      }
      const throughSeq = inRange.length === 0 ? fromSeq : Number(inRange[inRange.length - 1].seq)
      if (inRange.length > 0) write(input.sessionId, cursor.sourceGeneration, throughSeq, gap ? 'gap' : 'processing')
      return { records: inRange.map(summarizeObservationEvent), fromSeq, throughSeq, gap }
    },
    commitRead(input) {
      const cursor = latest(input.sessionId)
      if (cursor === null) return
      if (input.throughSeq < cursor.throughSeq) return
      write(input.sessionId, cursor.sourceGeneration, input.throughSeq, 'dirty')
    },
  }
}

/** Lazily-built extractor backend (only needed when PoC batches are enabled). */
interface BackendState {
  available: boolean
  reason: string | null
  extractorFor: ((sessionId: string) => MemoryExtractor | null) | null
  /**
   * Register the Session in BOOP's own observation plane first (the extractor
   * only processes a session BOOP already has a cursor on). Read-only against
   * the user's Session: it writes BOOP cursors only.
   */
  ensureObserved: ((sessionId: string) => Promise<void>) | null
}

function createBackend(ctx: any, config: BoopSchedulerConfig, permits: ModelPermits): BackendState {
  const route = config.modelRoute
  if (config.pocEnabled !== true) {
    return { available: false, reason: 'background batches are closed in this profile (POC_ENDPOINTS_DISABLED)', extractorFor: null, ensureObserved: null }
  }
  if (!route || typeof route.providerId !== 'string' || typeof route.modelId !== 'string' || typeof route.baseUrl !== 'string') {
    return { available: false, reason: 'background model route is not configured (no guessing)', extractorFor: null, ensureObserved: null }
  }
  const storage = storageOf(ctx)
  const scopeId = scopeIdOf(ctx)
  const observer = (() => {
    try {
      return ctx.boop?.observer?.() ?? null
    } catch {
      return null
    }
  })()
  if (storage?.repo === undefined || storage.repo === null || scopeId === null || observer === null) {
    return { available: false, reason: 'observation plane or ledger is unavailable; background batches are unavailable', extractorFor: null, ensureObserved: null }
  }
  let client: ReturnType<typeof createQwenClient>
  try {
    client = createQwenClient({
      providerId: route.providerId,
      modelId: route.modelId,
      credentialRef: route.credentialRef ?? NO_CREDENTIAL,
      baseUrl: route.baseUrl,
      contextWindowTokens: route.contextWindowTokens,
      declaredContext: route.declaredContext ?? null,
      quantization: route.quantization ?? null,
      externalFallbackAllowed: false,
    })
  } catch (error) {
    return {
      available: false,
      reason: `background model client is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      extractorFor: null,
      ensureObserved: null,
    }
  }
  const cursors = new LedgerCursorStore(storage.repo)
  const committer = new MemoryCommitter(storage.repo)
  const batch = createObservationBatch(ctx, cursors, scopeId)
  const extractors = new Map<string, MemoryExtractor>()
  return {
    available: true,
    reason: null,
    async ensureObserved(sessionId: string): Promise<void> {
      // Discovery is bounded and writes only BOOP's own cursors (`fresh`, -1).
      await observer.scan()
      const rows = cursors.all(scopeId).filter((row) => row.sessionId === sessionId)
      if (rows.length === 0) throw new Error(`Session ${sessionId} is not discoverable through the observation plane`)
    },
    extractorFor(sessionId: string): MemoryExtractor | null {
      const cached = extractors.get(sessionId)
      if (cached) return cached
      const extractor = new MemoryExtractor({
        client,
        batch,
        cursors,
        committer,
        store: storage.repo,
        permits,
        config: {
          scopeId,
          owner: { type: 'session', id: sessionId },
          maxInputTokens: SCHEDULER_DEFAULTS.maxInputTokens,
          // 2k is inside the frozen 2k–4k output band and keeps a background
          // batch cheap; the extractor clamps it to its own accepted range.
          maxOutputTokens: SCHEDULER_DEFAULTS.minOutputTokens,
          softTimeoutMs: config.softTimeoutMs ?? SCHEDULER_DEFAULTS.softTimeoutMs,
        },
        onAudit: (event) => {
          try {
            ctx.logger?.info?.(`[boop] ${event.kind}`, {
              sessionId: event.sessionId,
              providerId: event.providerId,
              modelId: event.modelId,
              detail: event.detail,
            })
          } catch {
            /* logging must never break a batch */
          }
        },
      })
      extractors.set(sessionId, extractor)
      return extractor
    },
  }
}

function makeScheduler(
  ctx: any,
  config: BoopSchedulerConfig,
  permits: ModelPermits,
  auditSink: SchedulerAuditSink,
): BoopScheduler {
  let backend: BackendState | null = null
  const backendOf = (): BackendState => {
    backend ??= createBackend(ctx, config, permits)
    return backend
  }
  return new BoopScheduler({
    permits,
    mergeWindowMs: config.mergeWindowMs ?? SCHEDULER_DEFAULTS.mergeWindowMs,
    maxJobAttempts: config.maxJobAttempts ?? SCHEDULER_DEFAULTS.maxJobAttempts,
    onAudit: (event) => {
      try {
        auditSink.record(event)
      } catch {
        /* never break scheduling from an audit failure */
      }
    },
    runBatch: async ({ job, signal }) => {
      const sessionId = job.scope.sessionId
      if (sessionId === undefined) {
        return { status: 'unavailable', reason: 'NO_BATCH_TARGET: a background batch needs a session scope' }
      }
      const state = backendOf()
      if (!state.available || state.extractorFor === null) {
        return { status: 'unavailable', reason: `BACKGROUND_CLOSED: ${state.reason ?? 'not enabled'}` }
      }
      const extractor = state.extractorFor(sessionId)
      if (!extractor) return { status: 'unavailable', reason: 'BACKGROUND_CLOSED: extractor unavailable' }
      try {
        if (state.ensureObserved !== null) await state.ensureObserved(sessionId)
        const result = await extractor.extract({ sessionId, signal })
        return result as unknown as BatchOutcome
      } catch (error) {
        return {
          status: signal.aborted ? 'cancelled' : 'failed',
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}

function bindingOf(ctx: any, config: BoopSchedulerConfig): NativeAutomationBinding {
  return new NativeAutomationBinding({
    // Resolve on demand: rc.2.1 rows mount in layer order, so an optional
    // service may appear after this row activates.
    port: () => nativeSchedulePortOf(ctx),
    sessionId: () => mainSessionIdOf(ctx),
    ...(config.dailyTime === undefined ? {} : { dailyTime: config.dailyTime }),
    ...(config.timeZone === undefined ? {} : { timeZone: config.timeZone }),
  })
}

/* ── Remote service (the UI/IM transport plane) ───────────────────────── */

/**
 * Typert Remote owner for the generated `boopScheduler` namespace. Every method
 * takes ONE `request` object (rc.2.1 SRC wire convention) and returns a
 * SINGLE-LAYER fact object as `result.value`.
 */
class BoopSchedulerApi extends TypertRemoteService {
  private readonly ctx: any
  private readonly config: BoopSchedulerConfig
  private readonly runtime: SchedulerRuntime

  constructor(ctx: any, runtime: SchedulerRuntime) {
    super(ctx, SCHEDULER_REMOTE_NAMESPACE, { namespace: SCHEDULER_REMOTE_NAMESPACE })
    this.ctx = ctx
    this.config = runtime.config
    this.runtime = runtime
  }

  /** Read-only: queue/permits/recent batches, patrol result, native binding, write mode. */
  status(_request?: unknown): SchedulerStatusResponse {
    const writeMode = writeModeFacts(this.ctx)
    const route = this.runtime.modelRoute
    return {
      schemaVersion: 1,
      row: SCHEDULER_ROW_ID,
      remoteService: SCHEDULER_REMOTE_NAMESPACE,
      at: new Date().toISOString(),
      writeMode,
      gates: (() => {
        try {
          return { ...(this.ctx.boop?.state?.()?.gates ?? {}) }
        } catch {
          return {}
        }
      })(),
      background: {
        pocEnabled: this.config.pocEnabled === true,
        modelRoute:
          route === null
            ? null
            : {
                providerId: route.providerId,
                modelId: route.modelId,
                baseUrl: route.baseUrl,
                contextWindowTokens: route.contextWindowTokens,
                credential: route.credentialRef === undefined ? 'none' : route.credentialRef,
              },
        note:
          this.config.pocEnabled === true
            ? 'background batches are enabled for this isolated profile only'
            : 'background model batches are closed; the deterministic control entries and patrol stay available',
      },
      scheduler: this.runtime.scheduler.status(),
      patrol: this.runtime.lastPatrol,
      native: this.runtime.binding.status(),
      endpoints: SCHEDULER_ENDPOINTS,
      pocEndpoints: this.config.pocEnabled === true ? SCHEDULER_POC_ENDPOINTS : [],
      controlEndpoints: ['pause', 'resume', 'cancel'],
      readEndpoints: SCHEDULER_READ_ENDPOINTS,
    }
  }

  /** P0: pause matching background work (deterministic; no model; no server claim). */
  pause(request?: any): SchedulerControlResponse {
    return this.control('pause', request)
  }

  /** P0: resume a paused scope. */
  resume(request?: any): SchedulerControlResponse {
    return this.control('resume', request)
  }

  /** P0: cancel matching background work (client abort requested; not server-side). */
  cancel(request?: any): SchedulerControlResponse {
    return this.control('cancel', request)
  }

  private control(action: 'pause' | 'resume' | 'cancel', request: unknown): SchedulerControlResponse {
    const scope = normalizeControlScope(request)
    const writeMode = writeModeFacts(this.ctx)
    if (scope === null) {
      const invalid: ControlResultFacts = {
        ok: false,
        code: 'INVALID_SCOPE',
        action,
        scope: { kind: 'all' },
        changed: false,
        queuedRemoved: [],
        abortRequested: [],
        alreadyFinished: [],
        stillRunning: [],
        paused: { all: false, scopes: [] },
        audit: {
          sink: this.runtime.auditSink.sink(),
          event: { kind: `scheduler/${action}`, at: new Date().toISOString(), scope: null, detail: 'invalid scope' },
        },
        note: 'scope must be "all" or {kind: "task"|"action"|"session", id}',
      }
      return { ...invalid, writeMode, dispatch: 'gated (this row never dispatches)' }
    }
    const facts =
      action === 'pause'
        ? this.runtime.scheduler.pause(scope)
        : action === 'resume'
          ? this.runtime.scheduler.resume(scope)
          : this.runtime.scheduler.cancel(scope)
    const receipt = this.runtime.auditSink.record(facts.audit.event)
    this.runtime.scheduler.setAuditSink(receipt.sink)
    return {
      ...facts,
      audit: { sink: receipt.sink, event: facts.audit.event },
      writeMode,
      dispatch: 'gated (this row never dispatches)',
    }
  }

  /** Read-only patrol: lease / cursors / approvals / outbox / gate / native binding. */
  patrolNow(_request?: unknown): PatrolFacts {
    const patrol = runPatrol(
      patrolPortsOf(this.ctx, this.runtime.binding, this.runtime.modelRoute, () => Date.now()),
      { intervalMs: this.config.patrolIntervalMs ?? PATROL_DEFAULT_INTERVAL_MS },
    )
    this.runtime.lastPatrol = patrol
    return patrol
  }

  /** Native automation lifecycle: bind / unbind / status (never touches user reminders). */
  async automation(request?: unknown): Promise<NativeBindingStatus> {
    const action = (() => {
      if (request && typeof request === 'object' && typeof (request as Record<string, unknown>).action === 'string') {
        return String((request as Record<string, unknown>).action)
      }
      return 'status'
    })()
    if (action === 'bind') {
      const status = await this.runtime.binding.bind()
      this.runtime.auditSink.record({
        kind: 'scheduler/automation-bind',
        at: new Date().toISOString(),
        detail: `${status.state}${status.taskId === null ? '' : ` ${status.taskId}`}`,
      })
      return status
    }
    if (action === 'unbind') {
      const status = await this.runtime.binding.unbind()
      this.runtime.auditSink.record({
        kind: 'scheduler/automation-unbind',
        at: new Date().toISOString(),
        detail: status.state,
      })
      return status
    }
    return this.runtime.binding.status()
  }

  /**
   * PoC-only: run ONE bounded background batch for a named Session through the
   * real extractor + permit, then report the batch record. Closed by default.
   */
  async pocRunBackground(request?: unknown): Promise<PocRunBackgroundFacts> {
    const writeMode = writeModeFacts(this.ctx)
    const record = request && typeof request === 'object' ? (request as Record<string, unknown>) : {}
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
    const base = {
      sessionId,
      modelCalls: 0,
      writeMode,
    }
    if (this.config.pocEnabled !== true) {
      return {
        ...base,
        ok: false,
        code: 'POC_ENDPOINTS_DISABLED',
        jobId: null,
        state: 'rejected',
        batch: null,
        note: 'poC background batches are closed in this profile',
      }
    }
    if (sessionId === '') {
      return { ...base, ok: false, code: 'INVALID_SESSION', jobId: null, state: 'rejected', batch: null, note: 'sessionId is required' }
    }
    this.runtime.scheduler.noteForegroundIdle()
    const submitted = this.runtime.scheduler.submit({
      priority: 'P3',
      label: `E05-01 PoC background batch (${sessionId})`,
      scope: { sessionId },
    })
    if (!submitted.accepted) {
      return {
        ...base,
        ok: false,
        code: submitted.code ?? 'JOB_REJECTED',
        jobId: null,
        state: 'rejected',
        batch: null,
        note: 'the scheduler refused the background job (paused scope or invalid priority)',
      }
    }
    void this.runtime.scheduler.drain()
    const jobId = submitted.jobId ?? null
    const deadline = Date.now() + 120_000
    let batch: BatchRecordLike | null = null
    while (Date.now() < deadline) {
      const recent = this.runtime.scheduler.status().recent
      const found = jobId === null ? undefined : recent.find((entry) => entry.jobId === jobId)
      if (found) {
        batch = {
          jobId: found.jobId,
          status: found.status,
          reason: found.reason,
          elapsedMs: found.elapsedMs,
          applied: found.applied,
          watermark: found.watermark,
          model: found.model,
        }
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!batch) {
      return {
        ...base,
        ok: false,
        code: 'BATCH_TIMEOUT',
        jobId,
        state: 'timeout',
        batch: null,
        note: 'the background batch did not finish within 120s',
      }
    }
    const modelCalls = batch.model.attempts ?? 0
    return {
      ...base,
      ok: true,
      jobId,
      state: 'completed',
      batch,
      modelCalls,
      note: `background batch finished with status ${batch.status}; model route ${String(batch.model.providerId)}/${String(batch.model.modelId)}`,
    }
  }
}

for (const method of ['status', 'pause', 'resume', 'cancel', 'patrolNow', 'automation']) {
  remote(method)(BoopSchedulerApi.prototype)
}

let pocSchedulerRegistered = false

/** Publish the background PoC method. A normal install never calls this. */
export function registerPocSchedulerMethods(): void {
  if (pocSchedulerRegistered) return
  remote('pocRunBackground')(BoopSchedulerApi.prototype)
  pocSchedulerRegistered = true
}

/* ── in-process facade (future controllers / tests) ──────────────────── */

export interface BoopSchedulerRules {
  status(request?: unknown): SchedulerStatusResponse
  pause(request?: unknown): SchedulerControlResponse
  resume(request?: unknown): SchedulerControlResponse
  cancel(request?: unknown): SchedulerControlResponse
  patrolNow(request?: unknown): PatrolFacts
  automation(request?: unknown): Promise<NativeBindingStatus>
  noteUserInput(): void
  noteForegroundIdle(): void
  submitBackground(input: { priority: 'P2' | 'P3' | 'P4'; label: string; scope?: Record<string, string> }): unknown
}

/* ── row lifecycle ────────────────────────────────────────────────────── */

export function apply(ctx: any, config: BoopSchedulerConfig = {}): void {
  if (config.enabled === false) {
    try {
      ctx.logger?.info?.('[boop] scheduler plane disabled by config; host continues')
    } catch {
      /* logging must never break activation */
    }
    return
  }
  try {
    config = { ...config, pocEnabled: pocRequested(config.pocEnabled) }
    const auditSink = new SchedulerAuditSink(ctx)
    const permits = new ModelPermits({
      softTimeoutMs: config.softTimeoutMs ?? SCHEDULER_DEFAULTS.softTimeoutMs,
    })
    const modelRoute = config.modelRoute ?? null
    const scheduler = makeScheduler(ctx, config, permits, auditSink)
    const binding = bindingOf(ctx, config)
    const runtime: SchedulerRuntime = {
      config,
      scheduler,
      binding,
      auditSink,
      lastPatrol: null,
      modelRoute,
    }
    scheduler.setAuditSink(auditSink.sink())
    if (config.pocEnabled === true) registerPocSchedulerMethods()
    new BoopSchedulerApi(ctx, runtime)

    // P1 wiring: a real user message arms foreground; the end of the turn
    // returns the scheduler to its idle window.
    ctx.on('session/event', (session: unknown, event: unknown) => {
      try {
        if (!event || typeof event !== 'object') return
        const record = event as { type?: unknown; data?: Record<string, unknown> }
        if (record.type === 'user/message') {
          const source = record.data?.source as { kind?: unknown } | undefined
          if (source?.kind === 'user') scheduler.noteUserInput()
        } else if (record.type === 'turn/end') {
          scheduler.noteForegroundIdle()
        }
        void session
      } catch {
        /* event wiring must never break the host */
      }
    })

    // Read-only compensation scan (03§16): no model, no business action.
    let patrolTimer: ReturnType<typeof setInterval> | null = null
    if (config.patrolTimer !== false && (config.patrolIntervalMs ?? PATROL_DEFAULT_INTERVAL_MS) > 0) {
      const intervalMs = config.patrolIntervalMs ?? PATROL_DEFAULT_INTERVAL_MS
      let patrolling = false
      patrolTimer = setInterval(() => {
        if (patrolling) return
        patrolling = true
        try {
          runtime.lastPatrol = runPatrol(
            patrolPortsOf(ctx, runtime.binding, runtime.modelRoute, () => Date.now()),
            { intervalMs },
          )
          void scheduler.drain()
        } catch {
          /* patrol must never throw out of its own timer */
        } finally {
          patrolling = false
        }
      }, intervalMs)
      if (typeof (patrolTimer as { unref?: () => void }).unref === 'function') (patrolTimer as { unref: () => void }).unref()
    }
    ctx.effect(() => () => {
      if (patrolTimer !== null) clearInterval(patrolTimer)
    }, 'boop: scheduler patrol timer')

    // Best-effort automation binding at boot; honest state until the main
    // Session identity is durably bound (pending-session) or the service is
    // missing (unavailable). Never creates a Session and never runs a model.
    void (async () => {
      try {
        await binding.bind()
      } catch {
        /* status reports the failure; boot continues */
      }
    })()

    ctx.logger?.info?.(
      `[boop] scheduler armed: single permit, merge ${config.mergeWindowMs ?? SCHEDULER_DEFAULTS.mergeWindowMs}ms, ` +
        `patrol ${config.patrolTimer === false ? 'timer off' : `${config.patrolIntervalMs ?? PATROL_DEFAULT_INTERVAL_MS}ms`}, ` +
        `background ${config.pocEnabled === true ? 'enabled (isolated profile)' : 'closed'}, automation ${binding.status().state}`,
    )
  } catch (error) {
    // A throwing optional row must warn, never break the host boot (03§05).
    try {
      ctx.logger?.warn?.('[boop] scheduler plane failed to arm; host continues', error)
    } catch {
      /* logging itself must never break activation */
    }
  }
}
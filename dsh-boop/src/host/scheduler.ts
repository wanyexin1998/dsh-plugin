/**
 * BOOP foreground/background scheduler (E05-01) — framework-free core.
 *
 * Frozen rules this module implements (02§05, 03§09/§16, issue E05-01):
 *  - BOOP schedules ITS OWN work; the DSH Agent Loop stays the executor of the
 *    user's chat. P1 (user input / bound IM input) is a STATE, not a job: the
 *    moment user input arrives, no NEW background batch may start, and the
 *    current background batch pauses at its next safe boundary. The native
 *    user turn always owns the next model window;
 *  - P0 (deterministic pause/cancel/approval-reject/security block) is handled
 *    by the deterministic control entries below — never by a model;
 *  - background work is split P2 (task-result / conflict checks, merged per
 *    task) < P3 (Session memory update, merged per Session) < P4 (history
 *    learning / archive, resumable). Same-topic events coalesce after a 2s idle
 *    window into ONE batch;
 *  - every BOOP self-managed model batch runs through the ONE shared permit
 *    (`permits.ts`, 1 concurrency, 45s soft timeout, cancellation, backoff).
 *    A batch runs one at a time and a completed batch never enqueues itself
 *    (no self-wake loop);
 *  - failures back off and retry a bounded number of times; a batch the
 *    extractor halted (two consecutive format failures) is dropped and its
 *    watermark stays with the extractor/cursor layer — the scheduler never
 *    "repairs" JSON and never advances coverage itself;
 *  - pause/resume/cancel are deterministic, scope-exact (all / task / action /
 *    session) and report partial success honestly: an in-flight model call is
 *    not claimed to be preempted server-side, it is only asked to abort its
 *    client request. Restart does NOT replay old background work: this
 *    scheduler holds memory only and starts with an empty queue.
 *
 * No Cordis/framework dependency: clock, timers, permit, batch runner and audit
 * sink are injected, so the policy is unit-testable with a deterministic clock.
 */

import {
  ModelPermits,
  PermitCancelledError,
  backoffDelayMs,
  delay,
  systemTimers,
  type TimerApi,
} from './model/permits.ts'

/* ── contract constants ───────────────────────────────────────────────── */

export const SCHEDULER_SCHEMA_VERSION = 1 as const
export const SCHEDULER_ROW_ID = 'boop-scheduler'
export const SCHEDULER_REMOTE_NAMESPACE = 'boopScheduler'
export const SCHEDULER_ENDPOINTS = [
  'boopScheduler/status',
  'boopScheduler/pause',
  'boopScheduler/resume',
  'boopScheduler/cancel',
  'boopScheduler/patrolNow',
  'boopScheduler/automation',
  'boopScheduler/pocRunBackground',
] as const
/** Deterministic, model-free control entries (allowed while write mode is off). */
export const SCHEDULER_CONTROL_ENDPOINTS = ['pause', 'resume', 'cancel'] as const
export const SCHEDULER_READ_ENDPOINTS = ['status', 'patrolNow', 'automation'] as const
/** Opt-in only (isolated profiles/tests); never wired in a production profile. */
export const SCHEDULER_POC_ENDPOINTS = ['pocRunBackground'] as const

export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4'

/** Lower rank runs first. P0/P1 are not model batches (see module header). */
export const PRIORITY_RANK: Readonly<Record<Priority, number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
}

/** Maintenance defaults (02§05). These are initial design values, not a guarantee. */
export const SCHEDULER_DEFAULTS = {
  /** Merge same-topic events after this idle window. */
  mergeWindowMs: 2_000,
  /** Read-only compensation scan interval (03§16); not a model cadence. */
  patrolIntervalMs: 60_000,
  /** Single background batch input cap (conservative estimate, not the model name). */
  maxInputTokens: 12_000,
  /** Output cap range (02§05: 2k–4k). */
  minOutputTokens: 2_000,
  maxOutputTokens: 4_096,
  /** First soft timeout for each BOOP self-managed call. */
  softTimeoutMs: 45_000,
  /** Attempts per batch (original + one backoff retry). */
  maxJobAttempts: 2,
  backoffBaseMs: 500,
  /** How many batches one idle window may run before waiting for new events. */
  maxBatchesPerIdleWindow: 10,
  /** Recent batch history kept for `status()`. */
  recentLimit: 10,
} as const

export type ScopeKind = 'all' | 'task' | 'action' | 'session'

export interface ControlScope {
  kind: ScopeKind
  /** Required for task/action/session; ignored for `all`. */
  id?: string
}

export interface JobScope {
  sessionId?: string
  taskId?: string
  actionId?: string
}

export type BatchOutcomeStatus =
  | 'committed'
  | 'no-change'
  | 'no-op'
  | 'rejected'
  | 'invalid-output'
  | 'halted'
  | 'gap'
  | 'not-observed'
  | 'input-too-large'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'failed'

/** What one background batch returns. Shaped to be satisfied by `ExtractionResult`. */
export interface BatchOutcome {
  status: BatchOutcomeStatus
  reason?: string | null
  version?: number | null
  applied?: string[]
  disputed?: string[]
  /** Whether the batch itself decided to stop (extractor format-failure rule). */
  halted?: boolean
  formatFailures?: number
  fromSeq?: number
  toSeq?: number
  watermark?: { before: number; after: number }
  model?: {
    providerId?: string | null
    modelId?: string | null
    attempts?: unknown[] | number | null
    elapsedMs?: number | null
    estimatedInputTokens?: number | null
  }
}

export interface BatchRunContext {
  job: ScheduledJob
  /** Per-job abort signal (deterministic cancel only). */
  signal: AbortSignal
}

export type BatchRunner = (context: BatchRunContext) => Promise<BatchOutcome>

export interface ScheduledJob {
  id: string
  priority: Priority
  label: string
  /** Merge identity (topic). One queued/running job per topic. */
  topicKey: string | null
  scope: JobScope
  enqueuedAt: number
  attempts: number
  /** Earliest time this job may run (backoff retries). */
  availableAt: number
  mergedEvents: number
}

export interface BatchRecord {
  jobId: string
  priority: Priority
  label: string
  topicKey: string | null
  scope: JobScope
  attempt: number
  startedAt: string
  finishedAt: string
  elapsedMs: number
  status: BatchOutcomeStatus
  reason: string | null
  halted: boolean
  formatFailures: number
  applied: string[]
  version: number | null
  watermark: { before: number; after: number } | null
  model: {
    providerId: string | null
    modelId: string | null
    attempts: number | null
    elapsedMs: number | null
  }
}

export interface SchedulerAuditEvent {
  kind: string
  at: string
  jobId?: string | null
  scope?: ControlScope | null
  detail?: string | null
}

export interface SchedulerOptions {
  /** The shared BOOP permit (the scheduler never creates a second one). */
  permits?: ModelPermits
  runBatch: BatchRunner
  timers?: TimerApi
  mergeWindowMs?: number
  maxJobAttempts?: number
  backoffBaseMs?: number
  recentLimit?: number
  maxBatchesPerIdleWindow?: number
  onAudit?: (event: SchedulerAuditEvent) => void
}

export interface QueueItemFacts {
  jobId: string
  priority: Priority
  label: string
  topicKey: string | null
  scope: JobScope
  enqueuedAt: string
  attempts: number
  mergedEvents: number
  /** Earliest run time when a backoff retry is pending. */
  availableAt: string | null
}

export interface SchedulerStatusFacts {
  schemaVersion: 1
  row: string
  at: string
  foreground: { active: boolean; since: string | null }
  paused: { all: boolean; scopes: ControlScope[] }
  queue: {
    P2: number
    P3: number
    P4: number
    total: number
    items: QueueItemFacts[]
  }
  running: {
    jobId: string
    priority: Priority
    label: string
    topicKey: string | null
    scope: JobScope
    startedAt: string
    elapsedMs: number
    cancelRequested: boolean
    pauseAfter: boolean
  } | null
  permits: { active: number; queued: number; note: string }
  recent: BatchRecord[]
  counters: {
    enqueued: number
    merged: number
    started: number
    completed: number
    failed: number
    retried: number
    cancelled: number
    dropped: number
  }
  background: {
    wire: 'memory-only'
    mergeWindowMs: number
    maxInputTokens: number
    outputTokensRange: [number, number]
    softTimeoutMs: number
    maxJobAttempts: number
    note: string
  }
  auditTail: SchedulerAuditEvent[]
}

export interface ControlResultFacts {
  ok: boolean
  code?: string
  action: 'pause' | 'resume' | 'cancel'
  scope: ControlScope
  changed: boolean
  /** Jobs removed from the queue (never started, no claim about server state). */
  queuedRemoved: string[]
  /** Jobs whose client request was asked to abort (server release not claimed). */
  abortRequested: string[]
  /** Jobs that already finished before the action could reach them. */
  alreadyFinished: string[]
  /** Work matching the scope that this action deliberately did NOT stop. */
  stillRunning: Array<{ jobId: string; reason: string }>
  paused: { all: boolean; scopes: ControlScope[] }
  audit: { sink: string; event: SchedulerAuditEvent }
  note: string
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function iso(timers: TimerApi): string {
  return new Date(timers.now()).toISOString()
}

function createIdFactory(): () => string {
  let counter = 0
  return () => `job-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Normalise the wire scope (`{scope:{kind,id}}`, `{kind,id}` or `"all"`). */
export function normalizeControlScope(input: unknown): ControlScope | null {
  if (input === 'all') return { kind: 'all' }
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    const nested = record.scope !== undefined ? record.scope : record
    if (nested === 'all') return { kind: 'all' }
    if (!nested || typeof nested !== 'object') return null
    const kind = String((nested as Record<string, unknown>).kind ?? '')
    if (kind !== 'all' && kind !== 'task' && kind !== 'action' && kind !== 'session') return null
    const rawId = (nested as Record<string, unknown>).id
    if (kind === 'all') return { kind }
    if (typeof rawId !== 'string' || rawId.trim() === '') return null
    return { kind, id: rawId.trim() }
  }
  return null
}

/** Does one job fall inside a control scope? Never guesses: exact id matching. */
export function jobMatchesScope(job: Pick<ScheduledJob, 'scope'>, scope: ControlScope): boolean {
  switch (scope.kind) {
    case 'all':
      return true
    case 'task':
      return scope.id !== undefined && job.scope.taskId === scope.id
    case 'action':
      return scope.id !== undefined && job.scope.actionId === scope.id
    case 'session':
      return scope.id !== undefined && job.scope.sessionId === scope.id
    default:
      return false
  }
}

function scopeLabel(scope: ControlScope): string {
  return scope.id === undefined ? scope.kind : `${scope.kind}:${scope.id}`
}

/* ── the scheduler ────────────────────────────────────────────────────── */

interface MergeBucket {
  priority: Priority
  label: string
  topicKey: string
  scope: JobScope
  events: number
  firstAt: number
  timer: unknown
}

interface RunningJob {
  job: ScheduledJob
  startedAt: number
  controller: AbortController
  cancelRequested: boolean
  pauseAfter: boolean
  finished: boolean
}

/**
 * One BOOP background scheduler.
 *
 * Queue ordering is (priority rank, enqueue time). Only one batch runs at a
 * time, through the injected `runBatch` (which must itself take the shared
 * permit); this class never calls a model directly.
 */
export class BoopScheduler {
  private readonly timers: TimerApi
  private readonly permits: ModelPermits
  private readonly runBatch: BatchRunner
  private readonly mergeWindowMs: number
  private readonly maxJobAttempts: number
  private readonly backoffBaseMs: number
  private readonly recentLimit: number
  private readonly maxBatchesPerIdleWindow: number
  private readonly onAudit: (event: SchedulerAuditEvent) => void
  private readonly nextId = createIdFactory()

  private readonly queues: Record<'P2' | 'P3' | 'P4', ScheduledJob[]> = { P2: [], P3: [], P4: [] }
  private readonly merges = new Map<string, MergeBucket>()
  private readonly recent: BatchRecord[] = []
  private readonly auditTail: SchedulerAuditEvent[] = []
  private readonly pausedScopes: ControlScope[] = []
  private running: RunningJob | null = null
  private foreground = false
  private foregroundSince: number | null = null
  private idleBatchCount = 0
  private idleWindowTimer: unknown = null
  private draining = false
  private readonly counters = {
    enqueued: 0,
    merged: 0,
    started: 0,
    completed: 0,
    failed: 0,
    retried: 0,
    cancelled: 0,
    dropped: 0,
  }

  constructor(options: SchedulerOptions) {
    this.timers = options.timers ?? systemTimers
    this.permits = options.permits ?? new ModelPermits({ timers: this.timers })
    this.runBatch = options.runBatch
    this.mergeWindowMs = options.mergeWindowMs ?? SCHEDULER_DEFAULTS.mergeWindowMs
    this.maxJobAttempts = Math.max(1, options.maxJobAttempts ?? SCHEDULER_DEFAULTS.maxJobAttempts)
    this.backoffBaseMs = options.backoffBaseMs ?? SCHEDULER_DEFAULTS.backoffBaseMs
    this.recentLimit = options.recentLimit ?? SCHEDULER_DEFAULTS.recentLimit
    this.maxBatchesPerIdleWindow = Math.max(1, options.maxBatchesPerIdleWindow ?? SCHEDULER_DEFAULTS.maxBatchesPerIdleWindow)
    this.onAudit = options.onAudit ?? (() => {})
  }

  /* ── audit ─────────────────────────────────────────────────────────── */

  private audit(kind: string, detail?: string | null, scope: ControlScope | null = null, jobId: string | null = null): void {
    const event: SchedulerAuditEvent = {
      kind,
      at: iso(this.timers),
      jobId,
      scope,
      detail: detail ?? null,
    }
    this.auditTail.push(event)
    if (this.auditTail.length > 50) this.auditTail.splice(0, this.auditTail.length - 50)
    try {
      this.onAudit(event)
    } catch {
      /* auditing must never break scheduling */
    }
  }

  /* ── foreground state (P1) ─────────────────────────────────────────── */

  /**
   * User input arrived (P1): NO new background batch may start. A running
   * background batch is asked to finish at its own safe boundary — the current
   * client request is not claimed to be preempted server-side.
   */
  noteUserInput(): void {
    const was = this.foreground
    this.foreground = true
    this.foregroundSince = this.timers.now()
    this.idleBatchCount = 0
    if (this.running) this.running.pauseAfter = true
    if (!was) this.audit('scheduler/foreground-entered', this.running ? 'background batch marked pause-after' : 'no background batch running')
  }

  /** The user's turn settled; background work may resume on the idle window. */
  noteForegroundIdle(): void {
    if (!this.foreground) return
    this.foreground = false
    this.foregroundSince = null
    this.idleBatchCount = 0
    this.audit('scheduler/foreground-idle')
    void this.drain()
  }

  isForeground(): boolean {
    return this.foreground
  }

  /* ── submission (P2/P3/P4; P0/P1 are states, not jobs) ─────────────── */

  /**
   * Submit one background event. Same-topic events inside the idle merge window
   * coalesce into ONE batch; a topic already queued/running is never duplicated.
   */
  submit(input: {
    priority: 'P2' | 'P3' | 'P4'
    label: string
    topicKey?: string | null
    scope?: JobScope
  }): { accepted: boolean; code?: string; jobId?: string; merged: boolean; topicKey: string | null } {
    const priority = input.priority
    if (priority !== 'P2' && priority !== 'P3' && priority !== 'P4') {
      return { accepted: false, code: 'INVALID_PRIORITY', merged: false, topicKey: input.topicKey ?? null }
    }
    const topicKey = typeof input.topicKey === 'string' && input.topicKey !== '' ? input.topicKey : null
    const scope: JobScope = input.scope ?? {}
    const now = this.timers.now()

    if (!topicKey) {
      // No merge identity: enqueue directly (callers that must not merge).
      const job = this.makeJob(priority, input.label, null, scope, 1, now)
      const accepted = this.enqueue(job)
      const code = accepted ? undefined : this.lastReject ?? 'REJECTED'
      if (accepted) void this.drain()
      return { accepted, merged: false, topicKey: null, jobId: job.id, ...(code === undefined ? {} : { code }) }
    }

    // One queued/running job per topic: attach the event instead of queueing a
    // second wake-up (02§05 "同任务事件合并，避免多次唤醒").
    const existing = this.findByTopic(topicKey)
    if (existing) {
      existing.mergedEvents += 1
      this.counters.merged += 1
      this.audit('scheduler/merged', `${topicKey} -> ${existing.id} (${existing.mergedEvents} events)`, null, existing.id)
      return { accepted: true, merged: true, jobId: existing.id, topicKey }
    }

    const bucket = this.merges.get(topicKey)
    if (bucket) {
      bucket.events += 1
      this.counters.merged += 1
      return { accepted: true, merged: true, topicKey }
    }
    const timer = this.timers.setTimeout(() => {
      this.flushMerge(topicKey)
    }, this.mergeWindowMs)
    this.merges.set(topicKey, {
      priority,
      label: input.label,
      topicKey,
      scope,
      events: 1,
      firstAt: now,
      timer,
    })
    this.audit('scheduler/merge-window', `${topicKey} opens for ${this.mergeWindowMs}ms`)
    return { accepted: true, merged: true, topicKey }
  }

  private lastReject: string | null = null

  private findByTopic(topicKey: string): ScheduledJob | null {
    if (this.running?.job.topicKey === topicKey && !this.running.finished) return this.running.job
    for (const priority of ['P2', 'P3', 'P4'] as const) {
      const found = this.queues[priority].find((job) => job.topicKey === topicKey)
      if (found) return found
    }
    return null
  }

  private flushMerge(topicKey: string): void {
    const bucket = this.merges.get(topicKey)
    if (!bucket) return
    this.merges.delete(topicKey)
    this.timers.clearTimeout(bucket.timer)
    this.idleBatchCount = 0
    const job = this.makeJob(bucket.priority, bucket.label, topicKey, bucket.scope, bucket.events, this.timers.now())
    const accepted = this.enqueue(job)
    this.audit(
      accepted ? 'scheduler/merge-flush' : 'scheduler/merge-dropped',
      `${topicKey} -> ${job.id} (${bucket.events} events)${accepted ? '' : `: ${this.lastReject ?? 'rejected'}`}`,
      null,
      accepted ? job.id : null,
    )
    if (accepted) void this.drain()
  }

  private makeJob(
    priority: 'P2' | 'P3' | 'P4',
    label: string,
    topicKey: string | null,
    scope: JobScope,
    mergedEvents: number,
    now: number,
  ): ScheduledJob {
    return {
      id: this.nextId(),
      priority,
      label,
      topicKey,
      scope,
      enqueuedAt: now,
      attempts: 0,
      availableAt: now,
      mergedEvents,
    }
  }

  /** Returns false (and records a code) when a paused scope holds the job. */
  private enqueue(job: ScheduledJob): boolean {
    this.lastReject = null
    const paused = this.pausedScopes.find((scope) => jobMatchesScope(job, scope))
    if (paused) {
      this.lastReject = `SCOPE_PAUSED:${scopeLabel(paused)}`
      this.counters.dropped += 1
      return false
    }
    if (job.priority !== 'P2' && job.priority !== 'P3' && job.priority !== 'P4') {
      this.lastReject = 'INVALID_PRIORITY'
      return false
    }
    this.queues[job.priority].push(job)
    this.counters.enqueued += 1
    this.audit('scheduler/enqueued', `${job.priority} ${job.label} (${job.mergedEvents} events)`, null, job.id)
    return true
  }

  /* ── the drain loop (one batch at a time; never self-waking) ────────── */

  /** Run due queued batches until the queue is idle, foreground blocks, or a pause holds. */
  async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (true) {
        if (this.foreground) {
          this.audit('scheduler/drain-blocked', 'foreground active: no new background batch starts')
          return
        }
        const next = this.takeNext()
        if (!next) return
        if (next.availableAt > this.timers.now()) {
          this.requeue(next)
          this.scheduleWake(next)
          return
        }
        if (this.idleBatchCount >= this.maxBatchesPerIdleWindow) {
          this.requeue(next)
          this.audit('scheduler/batch-limit', `idle window reached ${this.maxBatchesPerIdleWindow} batches; waiting for new events`)
          this.scheduleIdleWindowReset()
          return
        }
        await this.runOne(next)
      }
    } finally {
      this.draining = false
    }
  }

  private takeNext(): ScheduledJob | null {
    let best: ScheduledJob | null = null
    for (const priority of ['P2', 'P3', 'P4'] as const) {
      for (const job of this.queues[priority]) {
        if (!best) {
          best = job
          continue
        }
        const rank = PRIORITY_RANK[job.priority] - PRIORITY_RANK[best.priority]
        if (rank < 0 || (rank === 0 && job.enqueuedAt < best.enqueuedAt)) best = job
      }
    }
    if (best) this.queues[best.priority].splice(this.queues[best.priority].indexOf(best), 1)
    return best
  }

  private requeue(job: ScheduledJob): void {
    this.queues[job.priority].unshift(job)
  }

  private scheduleWake(job: ScheduledJob): void {
    const waitMs = Math.max(0, job.availableAt - this.timers.now())
    this.timers.setTimeout(() => {
      void this.drain()
    }, waitMs)
  }

  private scheduleIdleWindowReset(): void {
    if (this.idleWindowTimer !== null) return
    this.idleWindowTimer = this.timers.setTimeout(() => {
      this.idleWindowTimer = null
      this.idleBatchCount = 0
      void this.drain()
    }, this.mergeWindowMs)
  }

  private async runOne(job: ScheduledJob): Promise<void> {
    const controller = new AbortController()
    const running: RunningJob = {
      job,
      startedAt: this.timers.now(),
      controller,
      cancelRequested: false,
      pauseAfter: false,
      finished: false,
    }
    this.running = running
    this.idleBatchCount += 1
    this.counters.started += 1
    this.audit('scheduler/batch-start', `${job.priority} ${job.label} attempt ${job.attempts + 1}`, null, job.id)
    let outcome: BatchOutcome
    try {
      outcome = await this.runBatch({ job, signal: controller.signal })
    } catch (error) {
      outcome = {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    running.finished = true
    this.running = null
    const finishedAt = this.timers.now()
    const record = this.recordBatch(running, outcome, finishedAt)
    this.recent.push(record)
    if (this.recent.length > this.recentLimit) this.recent.splice(0, this.recent.length - this.recentLimit)

    if (outcome.status === 'cancelled' || controller.signal.aborted) {
      this.counters.cancelled += 1
      this.audit('scheduler/batch-cancelled', outcome.reason ?? 'cancelled', null, job.id)
    } else if (outcome.status === 'failed' || outcome.status === 'unavailable' || outcome.status === 'timeout') {
      this.counters.failed += 1
      await this.retryOrDrop(job, outcome)
    } else if (outcome.halted === true || outcome.status === 'halted') {
      this.counters.dropped += 1
      this.audit('scheduler/batch-halted', `${job.label} stopped after ${outcome.formatFailures ?? '?'} format failures; watermark preserved`, null, job.id)
    } else if (outcome.status === 'invalid-output') {
      this.counters.failed += 1
      await this.retryOrDrop(job, outcome)
    } else {
      this.counters.completed += 1
      this.audit('scheduler/batch-completed', `${job.label}: ${outcome.status}`, null, job.id)
    }

    if (running.pauseAfter) {
      this.audit('scheduler/pause-after', `${job.id} finished; no new background batch starts (foreground)`, null, job.id)
    }
  }

  private retryOrDrop(job: ScheduledJob, outcome: BatchOutcome): void {
    const nextAttempt = job.attempts + 1
    if (nextAttempt >= this.maxJobAttempts) {
      this.counters.dropped += 1
      this.audit('scheduler/batch-dropped', `${job.label}: ${outcome.status} after ${nextAttempt} attempt(s)`, null, job.id)
      return
    }
    const delayMs = backoffDelayMs(nextAttempt, { baseMs: this.backoffBaseMs })
    job.attempts = nextAttempt
    job.availableAt = this.timers.now() + delayMs
    this.counters.retried += 1
    this.queues[job.priority].push(job)
    this.audit(
      'scheduler/batch-retry',
      `${job.label}: ${outcome.status}; attempt ${nextAttempt + 1}/${this.maxJobAttempts} in ${delayMs}ms`,
      null,
      job.id,
    )
    this.scheduleWake(job)
  }

  private recordBatch(running: RunningJob, outcome: BatchOutcome, finishedAt: number): BatchRecord {
    const model = outcome.model ?? {}
    const attempts = model.attempts
    return {
      jobId: running.job.id,
      priority: running.job.priority,
      label: running.job.label,
      topicKey: running.job.topicKey,
      scope: running.job.scope,
      attempt: running.job.attempts + 1,
      startedAt: new Date(running.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      elapsedMs: finishedAt - running.startedAt,
      status: outcome.status,
      reason: outcome.reason ?? null,
      halted: outcome.halted === true,
      formatFailures: typeof outcome.formatFailures === 'number' ? outcome.formatFailures : 0,
      applied: Array.isArray(outcome.applied) ? outcome.applied.slice(0, 20) : [],
      version: typeof outcome.version === 'number' ? outcome.version : null,
      watermark: outcome.watermark ?? null,
      model: {
        providerId: typeof model.providerId === 'string' ? model.providerId : null,
        modelId: typeof model.modelId === 'string' ? model.modelId : null,
        attempts: Array.isArray(attempts) ? attempts.length : typeof attempts === 'number' ? attempts : null,
        elapsedMs: typeof model.elapsedMs === 'number' ? model.elapsedMs : null,
      },
    }
  }

  /* ── deterministic control entries (P0; no model) ──────────────────── */

  private matchesPaused(scope: ControlScope): boolean {
    return this.pausedScopes.some((paused) => paused.kind === scope.kind && (paused.kind === 'all' || paused.id === scope.id))
  }

  private controlResult(
    action: 'pause' | 'resume' | 'cancel',
    scope: ControlScope,
    changed: boolean,
    parts: {
      queuedRemoved?: string[]
      abortRequested?: string[]
      alreadyFinished?: string[]
      stillRunning?: Array<{ jobId: string; reason: string }>
      note: string
    },
  ): ControlResultFacts {
    const event: SchedulerAuditEvent = {
      kind: `scheduler/${action}`,
      at: iso(this.timers),
      scope,
      detail: `${scopeLabel(scope)}: removed=${(parts.queuedRemoved ?? []).length} aborted=${(parts.abortRequested ?? []).length}`,
    }
    this.auditTail.push(event)
    if (this.auditTail.length > 50) this.auditTail.splice(0, this.auditTail.length - 50)
    try {
      this.onAudit(event)
    } catch {
      /* auditing must never break control */
    }
    return {
      ok: true,
      action,
      scope,
      changed,
      queuedRemoved: parts.queuedRemoved ?? [],
      abortRequested: parts.abortRequested ?? [],
      alreadyFinished: parts.alreadyFinished ?? [],
      stillRunning: parts.stillRunning ?? [],
      paused: { all: this.pausedScopes.some((paused) => paused.kind === 'all'), scopes: [...this.pausedScopes] },
      audit: { sink: this.sink, event },
      note: parts.note,
    }
  }

  /** Set by the API row so the result can state where the audit landed. */
  sink = 'memory'

  setAuditSink(sink: string): void {
    this.sink = sink
  }

  /** P0: pause matching background work. Deterministic, no model, no server claim. */
  pause(scope: ControlScope): ControlResultFacts {
    if (!this.matchesPaused(scope)) this.pausedScopes.push(scope)
    const removed: string[] = []
    for (const priority of ['P2', 'P3', 'P4'] as const) {
      const kept: ScheduledJob[] = []
      for (const job of this.queues[priority]) {
        if (jobMatchesScope(job, scope)) removed.push(job.id)
        else kept.push(job)
      }
      this.queues[priority] = kept
    }
    for (const [topicKey, bucket] of [...this.merges.entries()]) {
      if (!jobMatchesScope(bucket, scope)) continue
      this.timers.clearTimeout(bucket.timer)
      this.merges.delete(topicKey)
      removed.push(`merge:${topicKey}`)
    }
    // In-flight work is NOT aborted here: pause waits for the safe boundary.
    const stillRunning: Array<{ jobId: string; reason: string }> = []
    if (this.running && !this.running.finished && jobMatchesScope(this.running.job, scope)) {
      this.running.pauseAfter = true
      stillRunning.push({
        jobId: this.running.job.id,
        reason: 'in-flight batch continues to its safe boundary; no new background batch starts (server-side preemption is not claimed)',
      })
    }
    this.audit('scheduler/pause', `${scopeLabel(scope)}: ${removed.length} queued removed`, scope)
    return this.controlResult('pause', scope, removed.length > 0 || stillRunning.length > 0, {
      queuedRemoved: removed,
      stillRunning,
      note:
        stillRunning.length > 0
          ? 'paused: queued work removed, one in-flight batch finishes at its safe boundary'
          : 'paused: matching queued work removed; no background batch is running',
    })
  }

  /** P0: resume a paused scope and let the queue drain again. */
  resume(scope: ControlScope): ControlResultFacts {
    const before = this.pausedScopes.length
    const kept = this.pausedScopes.filter(
      (paused) => !(paused.kind === scope.kind && (scope.kind === 'all' || paused.id === scope.id)),
    )
    this.pausedScopes.length = 0
    this.pausedScopes.push(...kept)
    const changed = this.pausedScopes.length !== before || scope.kind === 'all'
    this.audit('scheduler/resume', `${scopeLabel(scope)}: ${before - kept.length} pause(s) cleared`, scope)
    const result = this.controlResult('resume', scope, changed, {
      note: changed ? 'resumed: queued background batches may run again when foreground is idle' : 'nothing was paused for this scope',
    })
    if (changed) void this.drain()
    return result
  }

  /**
   * P0: cancel matching background work.
   *
   * Queued jobs are removed for certain. An in-flight batch gets its client
   * request aborted; BOOP does not claim the server-side inference stopped.
   */
  cancel(scope: ControlScope): ControlResultFacts {
    const removed: string[] = []
    for (const priority of ['P2', 'P3', 'P4'] as const) {
      const kept: ScheduledJob[] = []
      for (const job of this.queues[priority]) {
        if (jobMatchesScope(job, scope)) removed.push(job.id)
        else kept.push(job)
      }
      this.queues[priority] = kept
    }
    for (const [topicKey, bucket] of [...this.merges.entries()]) {
      if (!jobMatchesScope(bucket, scope)) continue
      this.timers.clearTimeout(bucket.timer)
      this.merges.delete(topicKey)
      removed.push(`merge:${topicKey}`)
    }
    const abortRequested: string[] = []
    if (this.running && !this.running.finished && jobMatchesScope(this.running.job, scope)) {
      this.running.cancelRequested = true
      this.running.controller.abort(new PermitCancelledError('cancelled by BOOP scheduler'))
      abortRequested.push(this.running.job.id)
    }
    this.audit('scheduler/cancel', `${scopeLabel(scope)}: ${removed.length} queued, ${abortRequested.length} in-flight`, scope)
    return this.controlResult('cancel', scope, removed.length > 0 || abortRequested.length > 0, {
      queuedRemoved: removed,
      abortRequested,
      note:
        abortRequested.length > 0
          ? 'cancelled: queued work removed; in-flight batch was asked to abort its client request (server-side release is not claimed)'
          : 'cancelled: matching queued work removed; nothing was running',
    })
  }

  /* ── status ────────────────────────────────────────────────────────── */

  status(): SchedulerStatusFacts {
    const items: QueueItemFacts[] = []
    for (const priority of ['P2', 'P3', 'P4'] as const) {
      for (const job of this.queues[priority]) {
        items.push({
          jobId: job.id,
          priority,
          label: job.label,
          topicKey: job.topicKey,
          scope: job.scope,
          enqueuedAt: new Date(job.enqueuedAt).toISOString(),
          attempts: job.attempts,
          mergedEvents: job.mergedEvents,
          availableAt: job.availableAt > this.timers.now() ? new Date(job.availableAt).toISOString() : null,
        })
      }
    }
    const running = this.running && !this.running.finished ? this.running : null
    return {
      schemaVersion: 1,
      row: SCHEDULER_ROW_ID,
      at: iso(this.timers),
      foreground: {
        active: this.foreground,
        since: this.foregroundSince === null ? null : new Date(this.foregroundSince).toISOString(),
      },
      paused: { all: this.pausedScopes.some((paused) => paused.kind === 'all'), scopes: [...this.pausedScopes] },
      queue: {
        P2: this.queues.P2.length,
        P3: this.queues.P3.length,
        P4: this.queues.P4.length,
        total: this.queues.P2.length + this.queues.P3.length + this.queues.P4.length,
        items,
      },
      running: running
        ? {
            jobId: running.job.id,
            priority: running.job.priority,
            label: running.job.label,
            topicKey: running.job.topicKey,
            scope: running.job.scope,
            startedAt: new Date(running.startedAt).toISOString(),
            elapsedMs: this.timers.now() - running.startedAt,
            cancelRequested: running.cancelRequested,
            pauseAfter: running.pauseAfter,
          }
        : null,
      permits: {
        active: this.permits.activeCount,
        queued: this.permits.queuedCount,
        note: 'one BOOP-wide model permit; background never takes a second slot',
      },
      recent: [...this.recent],
      counters: { ...this.counters },
      background: {
        wire: 'memory-only',
        mergeWindowMs: this.mergeWindowMs,
        maxInputTokens: SCHEDULER_DEFAULTS.maxInputTokens,
        outputTokensRange: [SCHEDULER_DEFAULTS.minOutputTokens, SCHEDULER_DEFAULTS.maxOutputTokens],
        softTimeoutMs: SCHEDULER_DEFAULTS.softTimeoutMs,
        maxJobAttempts: this.maxJobAttempts,
        note: 'in-memory queue: a restart starts empty and never replays old background write work',
      },
      auditTail: [...this.auditTail],
    }
  }

  /* ── test/operator helpers ─────────────────────────────────────────── */

  /** Await until no batch is running and (optionally) the queue is empty. */
  async waitForIdle(input: { timeoutMs?: number; untilQueueEmpty?: boolean } = {}): Promise<boolean> {
    const timeoutMs = input.timeoutMs ?? 5_000
    // Real wall clock: the injected timer clock may be frozen by a test.
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      const queueEmpty = this.queues.P2.length + this.queues.P3.length + this.queues.P4.length === 0
      if (!this.running && (input.untilQueueEmpty === false || queueEmpty) && this.merges.size === 0) return true
      await delay(0, { timers: systemTimers }).catch(() => {})
    }
    return !this.running
  }
}

/* ── native schedule automation binding ──────────────────────────────── */

export type NativeBindingState = 'bound' | 'unbound' | 'unavailable' | 'pending-session' | 'failed'

export interface NativeScheduleTask {
  id: string
  title?: string
  kind?: string
  scheduledAt?: string
  state?: string
}

/** Minimal port over rc.2.1 `schedule` (service methods; no Remote needed). */
export interface NativeSchedulePort {
  available(): boolean
  create(sessionId: string, request: Record<string, unknown>): Promise<NativeScheduleTask>
  delete(request: { sessionId: string; id: string }): Promise<{ id?: string; deleted?: boolean; code?: string }>
  list(request: { sessionId: string }): Promise<NativeScheduleTask[]>
}

export interface NativeBindingStatus {
  schemaVersion: 1
  state: NativeBindingState
  available: boolean
  service: 'schedule'
  marker: string
  sessionId: string | null
  taskId: string | null
  title: string | null
  kind: string | null
  scheduledAt: string | null
  lastError: string | null
  note: string
}

export const NATIVE_AUTOMATION_MARKER = '[BOOP] 主动节奏检查（自动注册）'
export const NATIVE_AUTOMATION_PROMPT =
  'BOOP 内部主动节奏检查：请先读取当前任务与来源状态，再判断是否需要向用户报告；没有重要变化时不要执行任何业务动作，也不要在本轮主动派发。'

/**
 * Binds BOOP's user-visible "active rhythm" wake to the NATIVE schedule
 * service (03§16/§77: native Schedule is optional and adapter-managed; a
 * missing service is explicitly unavailable and BOOP never fakes a side-channel
 * write timer).
 *
 * Safety rules:
 *  - only ONE task, created by BOOP with a fixed marker title, is ever created;
 *  - unbind deletes ONLY the recorded task id after re-reading it, never another
 *    task, never a user-owned reminder;
 *  - the binding is reported honestly: `pending-session` until the BOOP main
 *    Session identity is durably bound (no hidden Session is created here).
 */
export class NativeAutomationBinding {
  /**
   * The native service is resolved ON DEMAND: rc.2.1 rows mount in layer order
   * and an optional service may not be registered yet when this row activates.
   * A thunk keeps "unavailable" honest instead of freezing a boot-order fact.
   */
  private readonly portOf: () => NativeSchedulePort | null
  private readonly sessionIdOf: () => string | null
  private readonly dailyTime: string
  private readonly timeZone: string
  private taskId: string | null = null
  private title: string | null = null
  private kind: string | null = null
  private scheduledAt: string | null = null
  private state: NativeBindingState
  private lastError: string | null = null
  private note: string

  constructor(options: {
    port: NativeSchedulePort | null | (() => NativeSchedulePort | null)
    sessionId: () => string | null
    dailyTime?: string
    timeZone?: string
  }) {
    const supplied = options.port
    this.portOf = typeof supplied === 'function' ? supplied : () => supplied
    this.sessionIdOf = options.sessionId
    this.dailyTime = options.dailyTime ?? '09:00:00'
    this.timeZone = options.timeZone ?? 'Asia/Shanghai'
    const available = this.available()
    this.state = available ? 'unbound' : 'unavailable'
    this.note = available
      ? 'native schedule service available; binding not registered yet'
      : 'native schedule service is not mounted in this composition; BOOP reports unavailable instead of faking a timer'
  }

  private port(): NativeSchedulePort | null {
    try {
      return this.portOf()
    } catch {
      return null
    }
  }

  private available(): boolean {
    const port = this.port()
    try {
      return port !== null && port.available() === true
    } catch {
      return false
    }
  }

  status(): NativeBindingStatus {
    // `available` is a live fact (the optional service may mount later than this
    // row); the cached state must never contradict it. A binding that only ever
    // saw "unavailable" becomes "unbound" as soon as the service is mounted.
    const available = this.available()
    let state: NativeBindingState = this.state
    if (!available) state = 'unavailable'
    else if (state === 'unavailable') state = 'unbound'
    const note = !available && this.state !== 'unavailable'
      ? 'native schedule service is no longer reachable; automation stays unavailable'
      : this.note
    return {
      schemaVersion: 1,
      state,
      available,
      service: 'schedule',
      marker: NATIVE_AUTOMATION_MARKER,
      sessionId: this.sessionIdOf(),
      taskId: this.taskId,
      title: this.title,
      kind: this.kind,
      scheduledAt: this.scheduledAt,
      lastError: this.lastError,
      note,
    }
  }

  /** Register the single BOOP automation task (idempotent; never a second copy). */
  async bind(): Promise<NativeBindingStatus> {
    const port = this.port()
    if (!this.available() || port === null) {
      this.state = 'unavailable'
      this.note = 'native schedule service is not mounted; automation stays unavailable'
      return this.status()
    }
    if (this.state === 'bound' && this.taskId !== null) return this.status()
    const sessionId = this.sessionIdOf()
    if (sessionId === null) {
      this.state = 'pending-session'
      this.note = 'BOOP main Session identity is not durably bound yet; automation binding waits (no hidden Session is created)'
      return this.status()
    }
    try {
      // Never duplicate: re-read the session's tasks and adopt only OUR marker.
      const tasks = await port.list({ sessionId })
      const mine = tasks.find((task) => task.title === NATIVE_AUTOMATION_MARKER)
      if (mine) {
        this.taskId = mine.id
        this.title = mine.title ?? NATIVE_AUTOMATION_MARKER
        this.kind = mine.kind ?? null
        this.scheduledAt = mine.scheduledAt ?? null
        this.state = 'bound'
        this.lastError = null
        this.note = 'existing BOOP automation task adopted (no duplicate created)'
        return this.status()
      }
      const created = await port.create(sessionId, {
        title: NATIVE_AUTOMATION_MARKER,
        prompt: NATIVE_AUTOMATION_PROMPT,
        daily: { time: this.dailyTime, time_zone: this.timeZone },
      })
      this.taskId = created.id
      this.title = created.title ?? NATIVE_AUTOMATION_MARKER
      this.kind = created.kind ?? 'daily'
      this.scheduledAt = created.scheduledAt ?? null
      this.state = 'bound'
      this.lastError = null
      this.note = `bound to native schedule (daily ${this.dailyTime} ${this.timeZone}); delivery re-judges in BOOP, no standing permission`
      return this.status()
    } catch (error) {
      this.state = 'failed'
      this.lastError = error instanceof Error ? error.message : String(error)
      this.note = 'native schedule binding failed; automation unavailable until repaired'
      return this.status()
    }
  }

  /** Remove ONLY BOOP's own recorded task; user-owned reminders are never touched. */
  async unbind(): Promise<NativeBindingStatus> {
    const port = this.port()
    if (!this.available() || port === null) {
      this.state = 'unavailable'
      this.note = 'native schedule service is not mounted; nothing to unbind'
      return this.status()
    }
    const sessionId = this.sessionIdOf()
    if (sessionId === null || this.taskId === null) {
      this.state = this.taskId === null ? 'unbound' : this.state
      this.note = 'no BOOP automation task is registered'
      return this.status()
    }
    try {
      const tasks = await port.list({ sessionId })
      const mine = tasks.find((task) => task.id === this.taskId)
      if (!mine || mine.title !== NATIVE_AUTOMATION_MARKER) {
        this.state = 'unbound'
        this.taskId = null
        this.title = null
        this.kind = null
        this.scheduledAt = null
        this.note = 'BOOP automation task was already absent; nothing was deleted'
        return this.status()
      }
      const result = await port.delete({ sessionId, id: this.taskId })
      if (result.code !== undefined) {
        this.state = 'failed'
        this.lastError = String(result.code)
        this.note = 'native schedule refused the delete; automation may still be registered'
        return this.status()
      }
      this.state = 'unbound'
      this.taskId = null
      this.title = null
      this.kind = null
      this.scheduledAt = null
      this.lastError = null
      this.note = 'BOOP automation task deleted; user-owned reminders were not touched'
      return this.status()
    } catch (error) {
      this.state = 'failed'
      this.lastError = error instanceof Error ? error.message : String(error)
      this.note = 'native schedule unbind failed'
      return this.status()
    }
  }
}

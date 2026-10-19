/**
 * BOOP self-managed model permits (E03-02; E05-01 reuses this module).
 *
 * Frozen rules (02§05, 03§03):
 *  - every BOOP self-managed model job shares exactly ONE concurrency permit;
 *    background work never takes a second slot next to user-facing work;
 *  - a request already running on the service is not preempted by BOOP: the
 *    permit only serializes BOOP's OWN calls;
 *  - calls are short, cancellable, and carry a 45s first soft timeout — a soft
 *    timeout aborts the client request and reports honestly; BOOP never claims
 *    it stopped server-side inference;
 *  - failures back off (simple deterministic exponential delay) instead of
 *    hammering the shared GPU endpoint;
 *  - BOOP can only account for its own consumption; it never claims to control
 *    the whole DSH process or the service.
 *
 * Everything here is injectable (`TimerApi`, soft timeout, audit sink) so the
 * scheduling rules are testable deterministically without real sleeping.
 */

/** Minimal timer surface, injectable so tests never wait on wall-clock time. */
export interface TimerApi {
  now(): number
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** Real timers. Tests inject a deterministic clock instead. */
export const systemTimers: TimerApi = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Base class so callers can distinguish permit outcomes from provider errors. */
export class PermitError extends Error {
  readonly kind: 'soft-timeout' | 'cancelled'
  constructor(kind: 'soft-timeout' | 'cancelled', message: string) {
    super(message)
    this.name = kind === 'soft-timeout' ? 'PermitTimeoutError' : 'PermitCancelledError'
    this.kind = kind
  }
}

/** The call exceeded the soft timeout window; the result must be discarded. */
export class PermitTimeoutError extends PermitError {
  readonly softTimeoutMs: number
  constructor(softTimeoutMs: number) {
    super(
      'soft-timeout',
      `BOOP model call exceeded the ${softTimeoutMs}ms soft timeout; the client request was aborted and the result is discarded ` +
        '(server-side release is not claimed)',
    )
    this.name = 'PermitTimeoutError'
    this.softTimeoutMs = softTimeoutMs
  }
}

/** The caller (or a user action) cancelled the job. */
export class PermitCancelledError extends PermitError {
  constructor(message = 'BOOP model call was cancelled') {
    super('cancelled', message)
    this.name = 'PermitCancelledError'
  }
}

export type PermitEventKind = 'queued' | 'acquired' | 'released' | 'soft-timeout' | 'cancelled'

export interface PermitEvent {
  kind: PermitEventKind
  /** Caller label, e.g. `memory-extract:session-…`. Diagnostic only. */
  label: string | null
  /** Waiters behind this one when the event happened (0 = nobody queued). */
  queued: number
  /** How long this lease waited for the permit, in ms. */
  waitedMs: number
}

export interface ModelPermitsOptions {
  /** 45s first soft timeout (02§05). */
  softTimeoutMs?: number
  timers?: TimerApi
  onAudit?: (event: PermitEvent) => void
}

export interface PermitLease {
  /** Identity used by `release()`; a lease is released at most once. */
  readonly token: number
  readonly label: string | null
  /** Wait time before the permit was granted. */
  readonly waitedMs: number
  /**
   * Lease-level abort signal: fires on an external cancel. It does NOT carry
   * the soft timeout (that is per `withPermit` call), so long-lived owners can
   * hold the permit across several short calls.
   */
  readonly signal: AbortSignal
  release(): void
}

export const DEFAULT_SOFT_TIMEOUT_MS = 45_000

interface Waiter {
  resolve: (lease: PermitLease) => void
  reject: (error: Error) => void
  signal: AbortSignal | undefined
  label: string | null
  enqueuedAt: number
  onAbort: (() => void) | null
}

/**
 * The single BOOP-wide model permit.
 *
 * The class is deliberately transport-free: it only decides *when* a call may
 * run, never what it sends. Jobs either take a lease themselves or use
 * `withPermit`, which also applies cancellation and the soft timeout.
 */
export class ModelPermits {
  private readonly softTimeoutMs: number
  private readonly timers: TimerApi
  private readonly onAudit: (event: PermitEvent) => void
  private holderToken: number | null = null
  private nextToken = 1
  private readonly waiters: Waiter[] = []

  constructor(options: ModelPermitsOptions = {}) {
    this.softTimeoutMs = options.softTimeoutMs ?? DEFAULT_SOFT_TIMEOUT_MS
    this.timers = options.timers ?? systemTimers
    this.onAudit = options.onAudit ?? (() => {})
  }

  /** Number of leases currently running (0 or 1 by construction). */
  get activeCount(): number {
    return this.holderToken === null ? 0 : 1
  }

  /** Number of jobs waiting for the permit. */
  get queuedCount(): number {
    return this.waiters.length
  }

  private emit(kind: PermitEventKind, label: string | null, waitedMs: number): void {
    try {
      this.onAudit({ kind, label, queued: this.waiters.length, waitedMs })
    } catch {
      /* auditing must never break scheduling */
    }
  }

  private grant(label: string | null, waitedMs: number): PermitLease {
    const token = this.nextToken++
    this.holderToken = token
    this.emit('acquired', label, waitedMs)
    let released = false
    const controller = new AbortController()
    const self = this
    return {
      token,
      label,
      waitedMs,
      signal: controller.signal,
      release(): void {
        if (released) return
        released = true
        self.releaseToken(token, label)
        controller.abort(new PermitCancelledError('permit released'))
      },
    }
  }

  private releaseToken(token: number, label: string | null): void {
    if (this.holderToken !== token) return
    this.holderToken = null
    this.emit('released', label, 0)
    // Hand the permit straight to the oldest waiter (FIFO). A waiter whose
    // caller cancelled in the meantime is skipped, never granted.
    while (this.waiters.length > 0) {
      const next = this.waiters.shift() as Waiter
      if (next.onAbort && next.signal) next.signal.removeEventListener('abort', next.onAbort)
      if (next.signal?.aborted) {
        next.reject(new PermitCancelledError())
        continue
      }
      const waitedMs = this.timers.now() - next.enqueuedAt
      next.resolve(this.grant(next.label, waitedMs))
      return
    }
  }

  /**
   * Take the permit; queues FIFO when another BOOP job owns it.
   *
   * Cancellation while queued removes the waiter and never consumes the permit.
   */
  async acquire(input: { label?: string; signal?: AbortSignal } = {}): Promise<PermitLease> {
    const label = input.label ?? null
    const signal = input.signal
    if (signal?.aborted) throw new PermitCancelledError()
    if (this.holderToken === null && this.waiters.length === 0) return this.grant(label, 0)
    return await new Promise<PermitLease>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        label,
        enqueuedAt: this.timers.now(),
        onAbort: null,
      }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          this.emit('cancelled', label, this.timers.now() - waiter.enqueuedAt)
          reject(new PermitCancelledError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
      this.emit('queued', label, 0)
    })
  }

  /**
   * Run one task under the permit with cancellation and the soft timeout.
   *
   * The soft timeout starts when the permit is granted (a queued job is bounded
   * by its caller's signal, not by the model-call window). On timeout the
   * task's signal is aborted and `PermitTimeoutError` is thrown once the task
   * settles — the permit is not released before that, so a still-open request
   * never overlaps the next BOOP call.
   */
  async withPermit<T>(
    task: (signal: AbortSignal) => Promise<T>,
    input: { label?: string; signal?: AbortSignal } = {},
  ): Promise<{ value: T; waitedMs: number; elapsedMs: number }> {
    const lease = await this.acquire({ label: input.label, signal: input.signal })
    const controller = new AbortController()
    const external = input.signal
    let softTimedOut = false
    const onExternalAbort = () => controller.abort(new PermitCancelledError())
    if (external) {
      if (external.aborted) {
        lease.release()
        throw new PermitCancelledError()
      }
      external.addEventListener('abort', onExternalAbort, { once: true })
    }
    const timer = this.timers.setTimeout(() => {
      softTimedOut = true
      this.emit('soft-timeout', input.label ?? null, lease.waitedMs)
      controller.abort(new PermitTimeoutError(this.softTimeoutMs))
    }, this.softTimeoutMs)
    const startedAt = this.timers.now()
    try {
      const value = await task(controller.signal)
      if (softTimedOut) throw new PermitTimeoutError(this.softTimeoutMs)
      return { value, waitedMs: lease.waitedMs, elapsedMs: this.timers.now() - startedAt }
    } catch (error) {
      if (softTimedOut) throw new PermitTimeoutError(this.softTimeoutMs)
      if (external?.aborted) throw new PermitCancelledError()
      throw error
    } finally {
      this.timers.clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
      lease.release()
    }
  }
}

/** Simple deterministic exponential backoff (no jitter: testable and bounded). */
export function backoffDelayMs(
  attempt: number,
  options: { baseMs?: number; factor?: number; maxMs?: number } = {},
): number {
  const baseMs = options.baseMs ?? 500
  const factor = options.factor ?? 2
  const maxMs = options.maxMs ?? 8_000
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.trunc(attempt)) : 1
  const delay = baseMs * Math.pow(factor, safeAttempt - 1)
  return Math.min(maxMs, Math.max(0, delay))
}

/** Cancellable wait; resolves after `ms` or rejects with a cancellation. */
export async function delay(
  ms: number,
  options: { timers?: TimerApi; signal?: AbortSignal } = {},
): Promise<void> {
  const timers = options.timers ?? systemTimers
  const signal = options.signal
  if (signal?.aborted) throw new PermitCancelledError()
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | null = null
    const timer = timers.setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal) {
      onAbort = () => {
        timers.clearTimeout(timer)
        reject(new PermitCancelledError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

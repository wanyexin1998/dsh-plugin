/**
 * BOOP patrol (E05-01, 03§16) — read-only compensation scan.
 *
 * Frozen rules this module implements:
 *  - patrol is EVENT-DRIVEN plus a LIGHT compensation scan (default every 60s):
 *    it never runs a model, never executes a business action, never auto-
 *    recovers, never enqueues write work and never advances a watermark;
 *  - every plane it cannot read is reported as `unavailable` with a reason, never
 *    as an empty healthy result (FE-11: 断线不是空任务列表);
 *  - a detected condition becomes an ALERT FACT for the human/controller: the
 *    unknown outbox needs reconciliation, the recovery gate needs an explicit
 *    release, the lease being held by someone else means BOOP is read-only, the
 *    native schedule being absent means automation is unavailable — none of
 *    those is repaired silently here;
 *  - its output is bounded (counts + capped example rows) so a huge ledger can
 *    never turn the patrol into a full scan or a UI stall.
 *
 * The module is framework-free: all planes come through `PatrolPorts`.
 */

import type { NativeBindingStatus } from './scheduler.ts'

export const PATROL_SCHEMA_VERSION = 1 as const
export const PATROL_DEFAULT_INTERVAL_MS = 60_000
export const PATROL_EXAMPLE_LIMIT = 5

export type PatrolSeverity = 'info' | 'warn' | 'blocking'

export interface PatrolAlert {
  id: string
  code: string
  severity: PatrolSeverity
  message: string
  detail: string | null
}

export interface PatrolSealFacts {
  held: boolean
  holder: string
  fencingToken: number
  released: boolean
}

export interface PatrolPlane<T> {
  available: boolean
  reason: string | null
  value: T | null
}

export interface PatrolCursorFacts {
  total: number
  fresh: number
  dirty: number
  processing: number
  gap: number
  excluded: number
  /** A gap is a durable read discontinuity: memory coverage cannot be trusted. */
  gapSessions: string[]
  /** Sessions whose next batch is P3 work (dirty/processing). */
  pendingSessions: string[]
}

export interface PatrolApprovalFacts {
  pending: number
  expiredPending: number
  total: number
  examples: Array<{ id: string; status: string; expiresAt: string | null }>
}

export interface PatrolOutboxFacts {
  unknown: number
  sending: number
  blocked: number
  prepared: number
  examples: Array<{ actionId: string; state: string }>
}

export interface PatrolGateFacts {
  armed: boolean
  entries: number
  blocked: number
  released: number
  examples: Array<{ messageId: string; actionId: string; sessionId: string; state: string }>
}

export interface PatrolPorts {
  now?: () => number
  /** Single-writer lease facts (from the storage plane). */
  lease(): PatrolSealFacts | null
  /** BOOP's own source cursors (read-only). */
  cursors(): Array<{ sessionId: string; sourceGeneration: string; throughSeq: number; state: string }> | null
  approvals(): PatrolApprovalFacts | null
  outbox(): PatrolOutboxFacts | null
  gate(): PatrolGateFacts | null
  native(): NativeBindingStatus | null
  modelRoute(): { providerId: string; modelId: string } | null
  writeMode(): { enabled: boolean; blockedByGates: string[] } | null
}

export interface PatrolFacts {
  schemaVersion: 1
  at: string
  readOnly: true
  /** Patrol never calls a model; this integer is part of the contract. */
  modelCalls: 0
  durationMs: number
  intervalMs: number
  writeMode: PatrolPlane<{ enabled: boolean; blockedByGates: string[] }>
  lease: PatrolPlane<PatrolSealFacts>
  cursors: PatrolPlane<PatrolCursorFacts>
  approvals: PatrolPlane<PatrolApprovalFacts>
  outbox: PatrolPlane<PatrolOutboxFacts>
  gate: PatrolPlane<PatrolGateFacts>
  native: PatrolPlane<NativeBindingStatus>
  modelRoute: PatrolPlane<{ providerId: string; modelId: string }>
  alerts: PatrolAlert[]
  /** What this scan deliberately did NOT do. */
  notDone: string[]
}

function plane<T>(value: T | null, reason: string | null): PatrolPlane<T> {
  return value === null ? { available: false, reason: reason ?? 'plane unavailable', value: null } : { available: true, reason: null, value }
}

function alert(id: string, code: string, severity: PatrolSeverity, message: string, detail: string | null = null): PatrolAlert {
  return { id, code, severity, message, detail }
}

/**
 * Run one read-only patrol.
 *
 * Pure with respect to the ledger: the ports are read methods only, and nothing
 * in this module writes, cancels or retries anything.
 */
export function runPatrol(
  ports: PatrolPorts,
  options: { intervalMs?: number; now?: () => number } = {},
): PatrolFacts {
  const started = (options.now ?? ports.now ?? Date.now)()
  const alerts: PatrolAlert[] = []
  const notDone = [
    'no business action was executed',
    'no recovery was performed automatically (the recovery gate needs an explicit human release)',
    'no model was called',
    'no watermark, cursor or outbox row was advanced',
  ]

  /* ── write mode (expected OFF; reported, never alarmed as failure) ──── */
  let writeMode: PatrolPlane<{ enabled: boolean; blockedByGates: string[] }>
  try {
    const status = ports.writeMode()
    writeMode = plane(status, 'write-mode status unavailable')
    if (status === null) alerts.push(alert('write-mode', 'PLANE_UNAVAILABLE', 'warn', 'write-mode status is unavailable'))
  } catch {
    writeMode = plane(null, 'write-mode read threw')
    alerts.push(alert('write-mode', 'PLANE_UNAVAILABLE', 'warn', 'write-mode status is unavailable'))
  }

  /* ── single-writer lease ───────────────────────────────────────────── */
  let lease: PatrolPlane<PatrolSealFacts>
  try {
    const facts = ports.lease()
    lease = plane(facts, 'storage plane unavailable')
    if (facts === null) {
      alerts.push(alert('lease', 'STORAGE_UNAVAILABLE', 'warn', 'BOOP storage is unavailable; the host is in read-only diagnostics'))
    } else if (!facts.held && !facts.released) {
      alerts.push(
        alert(
          'lease',
          'LEASE_NOT_HELD',
          'warn',
          'this Host does not own the single-writer lease; BOOP is read-only against the data domain',
          `holder=${facts.holder || 'unknown'} fencing=${facts.fencingToken}`,
        ),
      )
    }
  } catch {
    lease = plane(null, 'lease read threw')
    alerts.push(alert('lease', 'PLANE_UNAVAILABLE', 'warn', 'lease facts are unavailable'))
  }

  /* ── source cursors / memory watermarks ────────────────────────────── */
  let cursors: PatrolPlane<PatrolCursorFacts>
  try {
    const rows = ports.cursors()
    if (rows === null) {
      cursors = plane(null, 'observation plane unavailable')
      alerts.push(alert('cursors', 'PLANE_UNAVAILABLE', 'warn', 'source cursors are unavailable; memory coverage cannot be judged'))
    } else {
      const facts: PatrolCursorFacts = {
        total: rows.length,
        fresh: rows.filter((row) => row.state === 'fresh').length,
        dirty: rows.filter((row) => row.state === 'dirty').length,
        processing: rows.filter((row) => row.state === 'processing').length,
        gap: rows.filter((row) => row.state === 'gap').length,
        excluded: rows.filter((row) => row.state === 'excluded').length,
        gapSessions: rows.filter((row) => row.state === 'gap').map((row) => row.sessionId).slice(0, PATROL_EXAMPLE_LIMIT),
        pendingSessions: rows
          .filter((row) => row.state === 'dirty' || row.state === 'processing')
          .map((row) => row.sessionId)
          .slice(0, PATROL_EXAMPLE_LIMIT),
      }
      cursors = plane(facts, null)
      if (facts.gap > 0) {
        alerts.push(
          alert(
            'cursors-gap',
            'MEMORY_COVERAGE_GAP',
            'warn',
            `${facts.gap} Session(s) have a durable read gap; memory coverage past the gap is not claimed`,
            facts.gapSessions.join(', '),
          ),
        )
      }
      if (facts.dirty + facts.processing > 0) {
        alerts.push(
          alert(
            'cursors-pending',
            'MEMORY_BEHIND',
            'info',
            `${facts.dirty + facts.processing} Session(s) have pending memory work (P3 idle-window batches)`,
            facts.pendingSessions.join(', '),
          ),
        )
      }
    }
  } catch {
    cursors = plane(null, 'cursor read threw')
    alerts.push(alert('cursors', 'PLANE_UNAVAILABLE', 'warn', 'source cursors are unavailable'))
  }

  /* ── approvals waiting for a human ─────────────────────────────────── */
  let approvals: PatrolPlane<PatrolApprovalFacts>
  try {
    const facts = ports.approvals()
    approvals = plane(facts, 'approval plane unavailable')
    if (facts === null) {
      alerts.push(alert('approvals', 'PLANE_UNAVAILABLE', 'warn', 'approval plane is unavailable; pending decisions are unknown, not absent'))
    } else if (facts.expiredPending > 0) {
      alerts.push(
        alert(
          'approvals-expired',
          'APPROVAL_EXPIRED_PENDING',
          'warn',
          `${facts.expiredPending} approval(s) are past their expiry but still pending; they must be invalidated, never silently decided`,
        ),
      )
    } else if (facts.pending > 0) {
      alerts.push(alert('approvals-pending', 'APPROVAL_PENDING', 'info', `${facts.pending} approval(s) wait for the human`))
    }
  } catch {
    approvals = plane(null, 'approval read threw')
    alerts.push(alert('approvals', 'PLANE_UNAVAILABLE', 'warn', 'approval plane is unavailable'))
  }

  /* ── unknown outbox (needs reconciliation, never auto-retry) ───────── */
  let outbox: PatrolPlane<PatrolOutboxFacts>
  try {
    const facts = ports.outbox()
    outbox = plane(facts, 'outbox plane unavailable')
    if (facts === null) {
      alerts.push(alert('outbox', 'PLANE_UNAVAILABLE', 'warn', 'command outbox is unavailable; unknown delivery results cannot be ruled out'))
    } else if (facts.unknown > 0) {
      alerts.push(
        alert(
          'outbox-unknown',
          'UNKNOWN_OUTBOX',
          'warn',
          `${facts.unknown} action(s) have an unknown delivery result; they need reconciliation, not an automatic resend`,
          facts.examples.map((row) => row.actionId).join(', '),
        ),
      )
    }
  } catch {
    outbox = plane(null, 'outbox read threw')
    alerts.push(alert('outbox', 'PLANE_UNAVAILABLE', 'warn', 'command outbox is unavailable'))
  }

  /* ── recovery gate (armed; blocked entries wait for explicit release) ─ */
  let gate: PatrolPlane<PatrolGateFacts>
  try {
    const facts = ports.gate()
    gate = plane(facts, 'recovery gate unavailable')
    if (facts === null) {
      alerts.push(alert('gate', 'PLANE_UNAVAILABLE', 'warn', 'recovery gate is unavailable on this composition'))
    } else if (!facts.armed) {
      alerts.push(alert('gate', 'GATE_NOT_ARMED', 'blocking', 'the recovery gate is not armed; BOOP must stay fail-closed'))
    } else if (facts.blocked > 0) {
      alerts.push(
        alert(
          'gate-blocked',
          'GATE_PENDING_RELEASE',
          'warn',
          `${facts.blocked} recovery-gate command(s) wait for an explicit human release; patrol never releases them`,
          facts.examples.map((row) => row.messageId).join(', '),
        ),
      )
    }
  } catch {
    gate = plane(null, 'recovery gate read threw')
    alerts.push(alert('gate', 'PLANE_UNAVAILABLE', 'warn', 'recovery gate is unavailable'))
  }

  /* ── native automation binding ─────────────────────────────────────── */
  let native: PatrolPlane<NativeBindingStatus>
  try {
    const binding = ports.native()
    native = plane(binding, 'native schedule status unavailable')
    if (binding === null) {
      alerts.push(alert('native', 'NATIVE_SCHEDULE_UNAVAILABLE', 'info', 'native schedule status is unavailable; automation is reported unavailable'))
    } else if (binding.state === 'unavailable') {
      alerts.push(alert('native', 'NATIVE_SCHEDULE_UNAVAILABLE', 'info', 'native schedule service is not mounted; automation is explicitly unavailable'))
    } else if (binding.state === 'failed') {
      alerts.push(
        alert('native', 'NATIVE_SCHEDULE_FAILED', 'warn', 'native automation binding failed', binding.lastError),
      )
    } else if (binding.state === 'pending-session') {
      alerts.push(alert('native', 'NATIVE_SCHEDULE_PENDING', 'info', 'automation binding waits for the BOOP main Session identity'))
    }
  } catch {
    native = plane(null, 'native status read threw')
    alerts.push(alert('native', 'NATIVE_SCHEDULE_UNAVAILABLE', 'info', 'native schedule status is unavailable'))
  }

  /* ── model route presence (background batches need it) ─────────────── */
  let modelRoute: PatrolPlane<{ providerId: string; modelId: string }>
  try {
    const route = ports.modelRoute()
    modelRoute = plane(route, 'no background model route configured')
    if (route === null) {
      alerts.push(alert('model-route', 'MODEL_ROUTE_MISSING', 'info', 'no BOOP background model route is configured; background batches report unavailable'))
    }
  } catch {
    modelRoute = plane(null, 'model route read threw')
  }

  const severityOrder: Record<PatrolSeverity, number> = { blocking: 0, warn: 1, info: 2 }
  alerts.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity] || left.id.localeCompare(right.id))

  const finished = (options.now ?? ports.now ?? Date.now)()
  return {
    schemaVersion: PATROL_SCHEMA_VERSION,
    at: new Date(finished).toISOString(),
    readOnly: true,
    modelCalls: 0,
    durationMs: Math.max(0, finished - started),
    intervalMs: options.intervalMs ?? PATROL_DEFAULT_INTERVAL_MS,
    writeMode,
    lease,
    cursors,
    approvals,
    outbox,
    gate,
    native,
    modelRoute,
    alerts,
    notDone,
  }
}

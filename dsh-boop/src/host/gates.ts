/**
 * Frozen gate ledger (G01–G09) — one honest source of truth.
 *
 * Frozen rules this file enforces:
 *  - only real, current evidence may write PASS; "estimated", "should work" and
 *    fixture-only results are NOT_RUN;
 *  - a gate that cannot be verified in this environment is BLOCKED, never PASS;
 *  - production write mode (dispatch, memory writes, workspace commits, …) stays
 *    OFF until every required gate is PASS — the ledger is consulted, not a
 *    hand-set boolean.
 *
 * Re-baselined on DSH 0.2.1-rc.2 (2026-10-18). Evidence refs are repository
 * paths / test files / commits so a reader can re-run them.
 */

export type GateState = 'PASS' | 'BLOCKED' | 'NOT_RUN'

export const FROZEN_GATES = ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09'] as const

export type GateId = (typeof FROZEN_GATES)[number]

export interface GateEntry {
  id: GateId
  state: GateState
  /** Why this state is honest right now (evidence path, command, or the gap). */
  evidence: string
}

/**
 * The required set for ANY production write (02§4 "放行规则"):
 * G01/G02/G03/G04/G05/G06/G08/G09 + the applicable TB checks. G07 is the
 * optional IM-channel gate and is not required to run the local product.
 */
export const WRITE_MODE_REQUIRED_GATES: readonly GateId[] = [
  'G01',
  'G02',
  'G03',
  'G04',
  'G05',
  'G06',
  'G08',
  'G09',
]

/** The current evidence ledger. Update ONLY together with real evidence. */
export const GATE_LEDGER: readonly GateEntry[] = [
  {
    id: 'G01',
    state: 'PASS',
    evidence:
      'commit 2c99dc2 re-baselined on 0.2.1-rc.2; tests/host/e00-01-plugin-load.test.mjs 11/11 ' +
      '(unauthenticated 401, bootstrap, row uniqueness, native-row isolation, bundle route, uninstall 404)',
  },
  {
    id: 'G02',
    state: 'PASS',
    evidence:
      'docs/development/evidence/e05-00/qwen-gold-report.md — real self-hosted Qwen: 8/8 capabilities PASS, ' +
      'effective context 196608 verified (near-limit accepted, over-limit HTTP 400)',
  },
  {
    id: 'G03',
    state: 'PASS',
    evidence:
      'real host + real Qwen: tests/host/e02-03-idempotency-in-host.test.mjs 6/6 x3 (51-55s) — same actionId/messageId ' +
      'retries return duplicate (never a new id, never a second delivery); outcome_unknown is reconciled against the ' +
      'durable log (user/message + splice pair + inbox projection; claimed is not durable): accepted / not-delivered / ' +
      'indeterminate, with not-delivered only under a clean-restart declaration and never auto-retried; repeated ' +
      'reconcile is idempotent (changed:false, one audit); SIGKILL+restart marks accepted from durable evidence with no ' +
      'replay; real model turn claim=1 / user-message=1. Boundary: the host itself has no cross-process messageId ' +
      'dedupe (covered at the BOOP dispatcher/adapter layer); production boot auto-reconcile is not wired yet.',
  },
  {
    id: 'G04',
    state: 'PASS',
    evidence:
      'official rc.2.1 `agent/pre-step` waterfall wired as row `boop-gate` (tests/host/e00-02-pre-step-gate.test.mjs ' +
      '8/8 with real host+Qwen): an unreleased boop-command is held before step/start / user commit / request / model ' +
      'call; explicit human release admits that same claimed message exactly once; ordinary user messages pass through; ' +
      'timeout / unarmed / unreadable ledger fail closed for BOOP commands; control plane now reports ' +
      'runtimeEnforcement.composed=true. Boundary: rc.2.1 has already written turn/start and taken the inbox claim ' +
      'before pre-step, so the gate guarantees "no step/no commit/no model", not "no turn/start"; a rejected claim is ' +
      'not revived (durable re-admission NOT_RUN).',
  },
  {
    id: 'G05',
    state: 'NOT_RUN',
    evidence:
      'partial: server-side approval/stop/recovery control plane PASS on a real host (tests/host/e04-03-control-in-host.test.mjs ' +
      '16/16: single-consume binding, APPROVAL_STALE isolation, deterministic stop scopes, explicit audited release); ' +
      'a real-browser harness now proves the Web UI renders real host facts (tools/web-e2e.mjs: 19/19 steps, screenshots in evidence/web-e2e/), but interactive approval/stop/recovery clicks, IME E2E and IM-side rules are NOT_RUN and write dispatch is still gated → gate not PASS',
  },
  {
    id: 'G06',
    state: 'PASS',
    evidence:
      'real host path E2E (tests/host/e03-03-lifecycle-in-host.test.mjs 6/6, e03-04-retrieval-in-host.test.mjs 8/8) on a ' +
      'real rc.2.1 host + SQLite ledger + plain-JSONL durable Session: three initialization modes, per-object failure ' +
      'listing, pause/resume, import preview->commit with execution canaries (not executed), correction with real source ' +
      'seq and impact range, forget-rule with the source Session byte-identical; layered retrieval reproducible, every ' +
      'hit carries a durable evidence address, generation change -> stale, superseded/forgotten facts excluded, FTS ' +
      'degraded stated. Real Qwen extraction commits 3 facts with subjectKey, disputed=0 (committer conflict semantics ' +
      'tightened to same (kind, subjectKey)); E03-02 real extraction 5/5. Boundary: lifecycle execution is test-side ' +
      'InitStore (no Host endpoint yet), cross-proposal subjectKey falls back conservatively (no columns yet), forget is ' +
      'rule-only (no tombstone), production query planner/FTS is not implemented.',
  },
  {
    id: 'G07',
    state: 'BLOCKED',
    evidence: 'IN-07/IN-08 (DingTalk/Feishu credentials) are not configured; channels stay OFF (M2).',
  },
  {
    id: 'G08',
    state: 'NOT_RUN',
    evidence:
      'partial: host-side storage/lease/migration/backup PASS (E00-03, E01-01, real host) and the writer-lease ' +
      'heartbeat now keeps a live Host from being fenced out (unit evidence); Desktop-side storage path and ' +
      'multi-host environment regression are pending E07-01 → gate not PASS',
  },
  {
    id: 'G09',
    state: 'NOT_RUN',
    evidence:
      'partial: client components and slots implemented (E04-01/02) and a real-browser harness now renders the panel/main-session/ordinary-session surfaces with real host facts (tools/web-e2e.mjs, 19/19, screenshots); Desktop Electron GUI and IME regression are NOT_RUN → gate not PASS',
  },
] as const

export interface WriteModeStatus {
  enabled: boolean
  /** Gates that must be PASS before any production write is allowed. */
  requiredGates: readonly GateId[]
  /** Required gates that are not PASS right now (why write mode is off). */
  blockedByGates: readonly GateId[]
  note: string
}

/** Pure gate map for the bootstrap/ledger surface. */
export function gateMap(ledger: readonly GateEntry[] = GATE_LEDGER): Record<GateId, GateState> {
  const entries = new Map(ledger.map((entry) => [entry.id, entry.state]))
  return Object.fromEntries(FROZEN_GATES.map((id) => [id, entries.get(id) ?? 'NOT_RUN'])) as Record<GateId, GateState>
}

/**
 * Derive the write-mode status from the ledger. There is no other switch: a
 * caller that wants writes must change evidence, not a boolean.
 */
export function writeModeStatus(
  ledger: readonly GateEntry[] = GATE_LEDGER,
  required: readonly GateId[] = WRITE_MODE_REQUIRED_GATES,
): WriteModeStatus {
  const gates = gateMap(ledger)
  const blockedByGates = required.filter((id) => gates[id] !== 'PASS')
  return {
    enabled: blockedByGates.length === 0,
    requiredGates: [...required],
    blockedByGates,
    note:
      blockedByGates.length === 0
        ? 'all required gates have current evidence'
        : `write mode stays OFF; blocked by ${blockedByGates.join(', ')}`,
  }
}

/**
 * Integrity check used by tests (and safe to call at boot): every frozen gate
 * appears exactly once, and a PASS must cite evidence.
 */
export function assertLedgerHonest(ledger: readonly GateEntry[]): void {
  const seen = new Set<GateId>()
  for (const entry of ledger) {
    if (seen.has(entry.id)) throw new Error(`gate ledger lists ${entry.id} twice`)
    seen.add(entry.id)
    if (!FROZEN_GATES.includes(entry.id)) throw new Error(`unknown gate id ${String(entry.id)}`)
    if (entry.state === 'PASS' && entry.evidence.trim().length === 0) {
      throw new Error(`gate ${entry.id} is PASS without evidence`)
    }
  }
  for (const id of FROZEN_GATES) {
    if (!seen.has(id)) throw new Error(`gate ledger is missing ${id}`)
  }
}

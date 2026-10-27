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
      'dedupe (covered at the BOOP dispatcher/adapter layer). Production boot now calls reconcileOutbox when this ' +
      'process holds the writer lease and records clean_shutdown only on graceful close (tests/unit/e03-05-host-init.test.mjs). ' +
      'A real-host SIGKILL replay of that marker is still the E07-01 evidence, not a new gate.',
  },
  {
    id: 'G04',
    state: 'PASS',
    evidence:
      'official rc.2.1 `agent/pre-step` waterfall wired as row `boop-gate`. ' +
      'tests/host/e00-02-pre-step-gate.test.mjs on 2026-10-27: 7 pass, 1 skipped (no Qwen env). An unreleased ' +
      'boop-command is held before step/start / user commit / request; explicit human release admits that same claimed ' +
      'message exactly once and, with the model port closed, ends in an error with no forged assistant reply; ordinary ' +
      'user messages pass through; timeout and an unreadable ledger fail closed. runtimeEnforcement.composed=true. ' +
      'Boundary: rc.2.1 has already written turn/start and taken the inbox claim before pre-step, so the gate ' +
      'guarantees "no step/no commit/no model", not "no turn/start"; a rejected claim is not revived.',
  },
  {
    id: 'G05',
    state: 'PASS',
    evidence:
      'Same rules on the host and in the browser after write mode opened. tests/host/e04-03-control-in-host.test.mjs ' +
      '16/16: an expired card is APPROVAL_STALE, a forged nonce does not invalidate the real card, and a moved task ' +
      'version stays pending. Edge docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z with write mode ' +
      'on: stop is a noop, recovery has no select-all, one allowed approval leaves the action awaiting_approval, and ' +
      'the moved-version card keeps 批准本次 disabled. The control row shows dispatch-not-on-this-row. IM admission ' +
      'rejects an unknown actor and has no approval-grant method; channels stay closed.',
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
      'tightened to same (kind, subjectKey)); E03-02 real extraction 5/5. Host initApply writes from_now watermarks and ' +
      'queues learn_history only when write mode and the writer lease are both held; import without a confirmed preview ' +
      'writes nothing (tests/unit/e03-05-host-init.test.mjs). subject_key is persisted. forget tombstones fact rows and ' +
      'a later commit of the same id is rejected. FTS5 search is enabled on the ledger and degrades to exact substring ' +
      'when the index misses or FTS5 is absent. ' +
      'On the real host with write mode and the writer lease, from_now watermarks and learn_history finishes the job ' +
      'after reading each resolved source; import without a confirmed preview still writes nothing ' +
      '(tests/host/e04-01b-main-session.test.mjs 10/10). learn_history does not call the model.',
  },
  {
    id: 'G07',
    state: 'BLOCKED',
    evidence:
      'IN-07/IN-08 are not configured. The main dsh-boop row mounts closedChannelRuntime only ' +
      '(tests/unit/e06-01-admission.test.mjs: unknown actor, redelivery, origin-only reply, remote approval text). ' +
      'No socket is opened. G07 stays BLOCKED until a real DingTalk or Feishu binding is tested.',
  },
  {
    id: 'G08',
    state: 'PASS',
    evidence:
      'Windows web host tests/host/e01-01-storage-in-host.test.mjs: one ledger under the private DSH_HOME, a second ' +
      'live Host stays read-only on the same fencing token while the first heartbeats, and a restart after release ' +
      'mints token+1. Unit tests/unit/e01-01-lease-heartbeat.test.mjs keeps a renewed lease past the TTL and refuses ' +
      'takeover; tests/unit/e00-03-storage.test.mjs covers node:sqlite, WAL, consistent backup, and a failed migration ' +
      'that leaves the previous schema readable. The Desktop 0.2.1-rc.3 GUI opened the same ledger ' +
      '(docs/development/evidence/desktop-gui/report.md) and a later boot in that window recorded boot/reconciled ' +
      'clean=true. A missing lease keeps write management off. macOS and Linux stay unclaimed.',
  },
  {
    id: 'G09',
    state: 'PASS',
    evidence:
      'Windows desktop 0.2.1-rc.3 private DSH_HOME (docs/development/evidence/desktop-gui/report.md, ' +
      'run desktop-gui-1793092410382, user ~/.dsh untouched): the board shows 写模式开启 and 派发不可用 ' +
      '(dispatch-not-on-this-row), no Invalid-hook/multiple-React console errors, light and dark both follow ' +
      'body[data-ds-dark-theme], package switch off removes the BOOP sidebar and all BOOP style sheets while 新会话 ' +
      'stays, and the same switch turns the sidebar back on without a restart notice. IME composition 波波 on the ' +
      'board search field is the Edge run docs/development/evidence/web-e2e-control/2026-10-27T09-16-44-730Z. ' +
      'macOS and Linux stay unclaimed in the support matrix.',
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

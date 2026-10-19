#!/usr/bin/env node
/**
 * E05-02 · Evidence verification + limited self-heal units.
 *
 * Fake read-only ledger/gate ports: no host is booted and no model is contacted.
 * What is proven is BOOP's own verification policy:
 *  - the chain "user criteria → artifact version → durable evidence → uncovered";
 *  - an Agent claim / finished turn is NEVER a pass (AT-16);
 *  - evidence from another task/artifact version is stale, never a pass (AT-17);
 *  - undecidable facts stay `unknown`, never a fake green;
 *  - the failure fingerprint is stable, and reaching the attempt limit stops
 *    further dispatch/self-heal (AT-18);
 *  - the self-heal plan is a preview only: never executed, gated by write mode,
 *    never bypassing the dispatcher.
 *
 * Run: node --test --test-force-exit tests/unit/e05-02-verifier.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_HEAL_ATTEMPT_LIMIT,
  EvidenceVerifier,
  InMemoryAttemptLedger,
  fingerprintOf,
  normalizeCheck,
  parseEvidenceRef,
} from '../../src/host/verify/verifier.ts'
import { planSelfHeal, renderSelfHealPlan } from '../../src/host/verify/self-heal.ts'

/* ── fixtures ─────────────────────────────────────────────────────────── */

const SCOPE = 'boop-test'
const TASK_ID = 'task-verify-1'
const SESSION = 'session-verify-1'
const GENERATION = `${SESSION}@4:1700000000000:`

function taskDetail(overrides = {}) {
  const detail = {
    task: {
      taskId: TASK_ID,
      version: 1,
      lifecycle: 'active',
      verification: 'pending',
      goal: '实现窄屏适配并通过验收',
      criteria: ['窄屏布局不溢出', '交互路径可完成'],
      exclusions: ['不部署'],
      ...(overrides.task ?? {}),
    },
    snapshot: {
      version: 1,
      goal: '实现窄屏适配并通过验收',
      criteria: ['窄屏布局不溢出', '交互路径可完成'],
      exclusions: ['不部署'],
      ...(overrides.snapshot ?? {}),
    },
    actions: [
      {
        actionId: 'action-1',
        taskVersion: 1,
        state: 'settled',
        targetSessionId: SESSION,
        messageId: 'msg-1',
        ...(overrides.action ?? {}),
      },
    ],
    evidence: [
      {
        factId: 'fact-1',
        factVersion: 1,
        useKind: 'verification',
        actionId: 'action-1',
        sessionId: SESSION,
        seq: 5,
        sourceHash: `${GENERATION}#5`,
        artifactRef: null,
        address: `session:${SESSION}#seq:5`,
        ...(overrides.evidence ?? {}),
      },
    ],
  }
  return detail
}

function ledgerOf(options = {}) {
  const provided = options.detail
  const wrapper =
    provided === undefined
      ? { available: true, reason: null, detail: taskDetail(options.detailOverrides) }
      : provided !== null && typeof provided === 'object' && 'available' in provided
        ? provided
        : { available: true, reason: null, detail: provided }
  return {
    taskDetail: () => wrapper,
    sourceGenerations: () => options.generations ?? { [SESSION]: GENERATION },
    fact: (factId) =>
      options.facts?.[factId] ?? { factId, version: 1, status: 'active', text: 'evidence fact' },
  }
}

function gateOf(writeMode = { enabled: false, blockedByGates: ['G03', 'G04', 'G05', 'G06'] }) {
  return { writeMode: () => writeMode }
}

function verifierOf(options = {}) {
  const attempts = new InMemoryAttemptLedger()
  return {
    attempts,
    verifier: new EvidenceVerifier({
      ledger: options.ledger ?? ledgerOf(options.ledgerOptions),
      gate: gateOf(options.writeMode),
      attempts,
      attemptLimit: options.attemptLimit ?? DEFAULT_HEAL_ATTEMPT_LIMIT,
      now: () => 1_700_000_000_000,
    }),
  }
}

/** A verification where the caller supplies the check RESULTS that already ran. */
function passingRequest(extra = {}) {
  return {
    taskId: TASK_ID,
    evidenceRefs: [`session:${SESSION}#seq:5`],
    checks: ['0:passed:窄屏截图与布局断言通过', '1:passed:交互路径手工核查通过'],
    ...extra,
  }
}

/* ── pure helpers ─────────────────────────────────────────────────────── */

test('E05-02 evidence addresses are parsed strictly and claims are not evidence', () => {
  assert.deepEqual(parseEvidenceRef(`session:${SESSION}#seq:5`), {
    raw: `session:${SESSION}#seq:5`,
    kind: 'session',
    sessionId: SESSION,
    seq: 5,
  })
  assert.deepEqual(parseEvidenceRef('fact:fact-1@3'), { raw: 'fact:fact-1@3', kind: 'fact', factId: 'fact-1', version: 3 })
  assert.equal(parseEvidenceRef('已经完成了')?.kind, 'claim')
  assert.equal(parseEvidenceRef('随便一句说明'), null)
  assert.equal(parseEvidenceRef('session:no-seq'), null)
})

test('E05-02 caller check strings normalise without trusting them', () => {
  assert.deepEqual(normalizeCheck('0:passed'), { criterionIndex: 0, state: 'passed' })
  assert.deepEqual(normalizeCheck('1:failed:断言失败'), { criterionIndex: 1, state: 'failed', detail: '断言失败' })
  assert.equal(normalizeCheck('x:passed'), null)
  assert.equal(normalizeCheck('0:maybe'), null)
  assert.equal(normalizeCheck(''), null)
})

test('E05-02 the failure fingerprint carries no path/time/sequence noise', () => {
  const first = fingerprintOf({ taskId: TASK_ID, conclusion: 'failed', failedCriteria: [1, 0], gaps: ['B', 'A'] })
  const second = fingerprintOf({ taskId: TASK_ID, conclusion: 'failed', failedCriteria: [0, 1], gaps: ['A', 'B'] })
  assert.equal(first, second, 'order and duplicates do not change the fingerprint')
  assert.equal(first.length, 32)
  const other = fingerprintOf({ taskId: TASK_ID, conclusion: 'failed', failedCriteria: [0], gaps: [] })
  assert.notEqual(first, other)
})

/* ── verification conclusions ────────────────────────────────────────── */

test('E05-02 a version-matched durable evidence plus passing check results is a pass', () => {
  const { verifier } = verifierOf()
  const result = verifier.verify(passingRequest())
  assert.equal(result.conclusion, 'passed', JSON.stringify(result))
  assert.equal(result.recommendedVerification, 'passed')
  assert.equal(result.available, true)
  assert.equal(result.ledgerWrites, 0, 'verification never writes the ledger')
  assert.equal(result.coverage.passed, 2)
  assert.equal(result.uncovered.length, 0)
  assert.equal(result.gates.evidenceVersionMatched, true)
  assert.equal(result.gates.evidenceCurrent, true)
  assert.equal(result.attempt, 0, 'a pass never counts as a repair attempt')
  assert.equal(result.nextAction, 'record-verification')
  assert.ok(result.evidence.some((entry) => entry.ref === `session:${SESSION}#seq:5` && entry.version === 1))
})

test('E05-02 an Agent claim alone is never a pass (AT-16)', () => {
  const { verifier } = verifierOf()
  const claimed = verifier.verify({ taskId: TASK_ID, claim: { text: '我已经全部完成并测试通过了' } })
  assert.equal(claimed.conclusion, 'unknown', JSON.stringify(claimed))
  assert.equal(claimed.claimObserved, true)
  assert.notEqual(claimed.recommendedVerification, 'passed')
  assert.notEqual(claimed.conclusion, 'passed')
  assert.ok(claimed.evidence.some((entry) => entry.agentClaim === true))
  assert.ok(claimed.evidence.some((entry) => entry.agentClaim === true))

  // A free-form evidenceRef that merely looks like a claim is classified too.
  const claimRef = verifier.verify({ taskId: TASK_ID, evidenceRefs: ['已完成'] })
  assert.equal(claimRef.claimObserved, true)
  assert.notEqual(claimRef.conclusion, 'passed')
})

test('E05-02 a failing check result is a failure even when the Agent claims done (AT-16)', () => {
  const { verifier } = verifierOf()
  const result = verifier.verify(
    passingRequest({ checks: ['0:passed', '1:failed:窄屏交互中断'], claim: { text: '全部完成' } }),
  )
  assert.equal(result.conclusion, 'failed')
  assert.equal(result.recommendedVerification, 'failed')
  assert.equal(result.coverage.failed, 1)
  assert.equal(result.criteria[1].outcome, 'failed')
  assert.equal(result.nextAction, 'plan-repair')
  assert.ok(result.attempt >= 1, 'a failure counts against its fingerprint')
})

test('E05-02 evidence from another task/artifact version is stale and never a pass (AT-17)', () => {
  const detail = taskDetail({ task: { version: 2 }, action: { taskVersion: 1 } })
  const { verifier } = verifierOf({ ledgerOptions: { detail } })
  const result = verifier.verify(passingRequest())
  assert.equal(result.conclusion, 'stale', JSON.stringify(result))
  assert.match(String(result.evidence[0].staleReason), /EVIDENCE_VERSION_MISMATCH/u)
  assert.equal(result.gates.evidenceVersionMatched, false)
  assert.notEqual(result.recommendedVerification, 'passed')
  assert.equal(result.nextAction, 'refresh-evidence')
})

test('E05-02 evidence from a source generation that moved on is stale', () => {
  const { verifier } = verifierOf({ ledgerOptions: { generations: { [SESSION]: `${SESSION}@4:1700000009999:` } } })
  const result = verifier.verify(passingRequest())
  assert.equal(result.conclusion, 'stale', JSON.stringify(result))
  assert.match(String(result.evidence[0].staleReason), /EVIDENCE_GENERATION_MOVED/u)
})

test('E05-02 an unresolvable evidence address cannot prove a pass', () => {
  const { verifier } = verifierOf()
  const result = verifier.verify({ taskId: TASK_ID, evidenceRefs: ['session:unknown#seq:9'], checks: ['0:passed', '1:passed'] })
  assert.notEqual(result.conclusion, 'passed', JSON.stringify(result))
  assert.ok(result.gaps.includes('EVIDENCE_VERSION_UNPROVEN'))
  assert.equal(result.evidence.find((entry) => entry.ref === 'session:unknown#seq:9').resolved, false)
})

test('E05-02 a partially covered task is partial, not passed', () => {
  const { verifier } = verifierOf()
  const result = verifier.verify({ taskId: TASK_ID, evidenceRefs: [`session:${SESSION}#seq:5`], checks: ['0:passed'] })
  assert.equal(result.conclusion, 'partial', JSON.stringify(result))
  assert.deepEqual(result.uncovered, [1])
  assert.equal(result.recommendedVerification, 'pending')
  assert.equal(result.nextAction, 'collect-evidence')
})

test('E05-02 a task without acceptance criteria stays unknown and asks the user', () => {
  const detail = taskDetail({ task: { criteria: [] }, snapshot: { criteria: [] } })
  const { verifier } = verifierOf({ ledgerOptions: { detail } })
  const result = verifier.verify({ taskId: TASK_ID, checks: [] })
  assert.equal(result.conclusion, 'unknown')
  assert.equal(result.reason, 'NO_ACCEPTANCE_CRITERIA')
  assert.equal(result.nextAction, 'define-criteria')
})

test('E05-02 a user waiver ends verification but is never shown as passed', () => {
  const detail = taskDetail({ task: { verification: 'waived' } })
  const { verifier } = verifierOf({ ledgerOptions: { detail } })
  const result = verifier.verify(passingRequest())
  assert.equal(result.conclusion, 'unknown')
  assert.equal(result.waived, true)
  assert.equal(result.recommendedVerification, 'waived')
  assert.notEqual(result.recommendedVerification, 'passed')
})

test('E05-02 a cancelled or draft task is never verified green', () => {
  for (const lifecycle of ['cancelled', 'draft']) {
    const detail = taskDetail({ task: { lifecycle } })
    const { verifier } = verifierOf({ ledgerOptions: { detail } })
    const result = verifier.verify(passingRequest())
    assert.equal(result.conclusion, 'unknown', `${lifecycle}: ${JSON.stringify(result)}`)
    assert.notEqual(result.recommendedVerification, 'passed')
  }
})

test('E05-02 unknown task and unreadable ledger degrade honestly', () => {
  const missing = verifierOf({
    ledgerOptions: { detail: { available: true, reason: null, detail: null } },
  }).verifier.verify({ taskId: TASK_ID })
  assert.equal(missing.conclusion, 'unknown')
  assert.equal(missing.reason, 'TASK_NOT_FOUND')
  assert.equal(missing.available, true, 'the ledger is readable; the task is simply absent')

  const unavailable = verifierOf({
    ledgerOptions: { detail: { available: false, reason: 'LEDGER_UNAVAILABLE', detail: 'no ledger handle' } },
  }).verifier.verify({ taskId: TASK_ID })
  assert.equal(unavailable.conclusion, 'unknown')
  assert.equal(unavailable.available, false)
  assert.equal(unavailable.reason, 'LEDGER_UNAVAILABLE')
})

test('E05-02 an action with an unknown outcome blocks a pass without lying', () => {
  const detail = taskDetail({ action: { state: 'outcome_unknown' } })
  const { verifier } = verifierOf({ ledgerOptions: { detail } })
  const result = verifier.verify(passingRequest())
  assert.notEqual(result.conclusion, 'passed', JSON.stringify(result))
  assert.ok(result.gaps.includes('EVIDENCE_OUTCOME_UNKNOWN'))
})

/* ── fingerprint attempt limit (AT-18) ───────────────────────────────── */

test('E05-02 the same failure fingerprint stops further repair after the limit (AT-18)', () => {
  const { verifier } = verifierOf()
  const failing = { taskId: TASK_ID, evidenceRefs: [`session:${SESSION}#seq:5`], checks: ['0:passed', '1:failed:断言失败'] }
  const first = verifier.verify(failing)
  const second = verifier.verify(failing)
  const third = verifier.verify(failing)
  assert.equal(first.attempt, 1)
  assert.equal(first.limitReached, false)
  assert.equal(second.attempt, 2)
  assert.equal(second.limitReached, true, 'limit is 2 by default')
  assert.equal(third.attempt, 3)
  assert.equal(third.limitReached, true)
  assert.equal(third.halted, true)
  assert.equal(third.nextAction, 'stop-dispatch', 'the loop stops instead of dispatching again')
  assert.equal(first.fingerprint, third.fingerprint, 'the fingerprint is stable across attempts')
})

test('E05-02 a different failure criterion gets a different fingerprint and its own budget', () => {
  const { verifier } = verifierOf()
  const failureA = { taskId: TASK_ID, evidenceRefs: [`session:${SESSION}#seq:5`], checks: ['0:failed', '1:passed'] }
  const failureB = { taskId: TASK_ID, evidenceRefs: [`session:${SESSION}#seq:5`], checks: ['0:passed', '1:failed'] }
  const a1 = verifier.verify(failureA)
  const a2 = verifier.verify(failureA)
  const b1 = verifier.verify(failureB)
  assert.equal(a1.limitReached, false)
  assert.equal(a2.limitReached, true)
  assert.notEqual(a1.fingerprint, b1.fingerprint)
  assert.equal(b1.attempt, 1, 'the other fingerprint has its own attempt count')
})

/* ── limited self-heal plan ──────────────────────────────────────────── */

test('E05-02 a passed verification needs no repair plan', () => {
  const { verifier } = verifierOf()
  const verification = verifier.verify(passingRequest())
  const plan = planSelfHeal({ verification, writeMode: { enabled: false, blockedByGates: ['G03'] } })
  assert.equal(plan.code, 'NO_REPAIR_NEEDED')
  assert.equal(plan.available, false)
  assert.equal(plan.executed, false)
  assert.deepEqual(plan.candidates, [])
})

test('E05-02 with write mode closed the repair plan is a preview only and never dispatched', () => {
  const { verifier } = verifierOf()
  const verification = verifier.verify(
    passingRequest({ checks: ['0:passed', '1:failed:窄屏交互中断'] }),
  )
  const plan = planSelfHeal({
    verification,
    writeMode: { enabled: false, blockedByGates: ['G03', 'G04', 'G05', 'G06'] },
  })
  assert.equal(plan.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(plan.executed, false, 'never executed')
  assert.equal(plan.dispatchAllowed, false, 'nothing may be dispatched while the gate is closed')
  assert.deepEqual(plan.blockedByGates, ['G03', 'G04', 'G05', 'G06'])
  assert.ok(plan.candidates.length >= 1)
  assert.equal(plan.candidates[0].kind, 'fix')
  assert.ok(plan.candidates[0].revalidateCriteria.includes(1))
  assert.equal(plan.candidates[0].requiresNewHypothesis, true)
  assert.match(plan.note, /No repair was dispatched/u)
  assert.match(renderSelfHealPlan(plan), /未执行、未派发/u)
})

test('E05-02 when the gate opens the plan is dispatch-eligible but still not executed here', () => {
  const { verifier } = verifierOf()
  const verification = verifier.verify(passingRequest({ checks: ['0:passed', '1:failed'] }))
  const plan = planSelfHeal({ verification, writeMode: { enabled: true, blockedByGates: [] } })
  assert.equal(plan.executed, false, 'dispatching stays the dispatcher write path')
  assert.equal(plan.dispatchAllowed, true, 'eligible for the controller to route through the dispatcher')
  assert.equal(plan.ok, true)
  assert.equal(plan.code, null)
  assert.match(plan.note, /single dispatcher write path/u)
})

test('E05-02 a stale-evidence failure plans an evidence refresh, not a blind code change', () => {
  const detail = taskDetail({ task: { version: 2 }, action: { taskVersion: 1 } })
  const { verifier } = verifierOf({ ledgerOptions: { detail } })
  const verification = verifier.verify(passingRequest())
  const plan = planSelfHeal({ verification, writeMode: { enabled: true, blockedByGates: [] } })
  const refresh = plan.candidates.find((candidate) => candidate.kind === 'refresh-evidence')
  assert.ok(refresh, JSON.stringify(plan.candidates))
  assert.match(refresh.instruction, /不要用过期证据声称通过/u)
})

test('E05-02 reaching the fingerprint limit stops the repair plan entirely (AT-18)', () => {
  const { verifier } = verifierOf()
  const failing = { taskId: TASK_ID, evidenceRefs: [`session:${SESSION}#seq:5`], checks: ['1:failed'] }
  verifier.verify(failing)
  const second = verifier.verify(failing)
  const plan = planSelfHeal({ verification: second, writeMode: { enabled: true, blockedByGates: [] } })
  assert.equal(plan.limitReached, true)
  assert.equal(plan.code, 'ATTEMPT_LIMIT_REACHED')
  assert.equal(plan.available, false)
  assert.equal(plan.executed, false)
  assert.deepEqual(plan.candidates, [], 'no further repair candidate is generated')
  assert.equal(plan.dispatchAllowed, false)
  assert.match(plan.stoppedBecause.join(' '), /limit stops further dispatch/u)
})

test('E05-02 an Agent claim cannot be turned into a repair target (no self-exemption)', () => {
  const { verifier } = verifierOf()
  const verification = verifier.verify({ taskId: TASK_ID, claim: { text: '我完成了' } })
  const plan = planSelfHeal({ verification, writeMode: { enabled: false, blockedByGates: ['G06'] } })
  assert.ok(plan.candidates.some((candidate) => candidate.kind === 'ask-user' || candidate.kind === 'investigate'))
  assert.ok(plan.candidates.every((candidate) => candidate.instruction.includes('不要') || candidate.kind === 'ask-user'))
  assert.notEqual(plan.code, 'NO_REPAIR_NEEDED')
})

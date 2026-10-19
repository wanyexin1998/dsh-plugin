/**
 * BOOP limited self-heal planning (E05-02, 02§10, issue E05-02).
 *
 * Frozen rules this module implements:
 *  - the unit of self-heal is ONE authorized task plus its cumulative drift, not
 *    an individual tool command. The same failure fingerprint may drive at most
 *    `limit` auto-repair attempts and every attempt needs a NEW verifiable
 *    hypothesis — sunk cost never extends the limit (AT-18);
 *  - stop immediately when the change would cross the original file/resource
 *    scope, needs a refactor-level change, produces an external side effect,
 *    requires user intervention or changes permissions. This module therefore
 *    only ever produces a PREVIEW: it never edits, never dispatches and never
 *    bypasses the dispatcher (the single write path);
 *  - while write mode is closed it still returns the honest plan with
 *    `executed:false` / `dispatchAllowed:false` and the blocking gates, and the
 *    caller audits the request; nothing is applied;
 *  - a passed verification needs no repair, and an Agent claim is never treated
 *    as evidence to repair toward.
 */

import {
  DEFAULT_HEAL_ATTEMPT_LIMIT,
  VERIFY_SCHEMA_VERSION,
  type VerifyResultFacts,
} from './verifier.ts'

export const SELF_HEAL_SCHEMA_VERSION = 1 as const

export type HealCandidateKind = 'fix' | 'investigate' | 'refresh-evidence' | 'ask-user'

export interface SelfHealCandidateFacts {
  id: string
  kind: HealCandidateKind
  /** Exact object the candidate may touch (`criterion:<n>` / `evidence:<ref>`). */
  target: string
  /** Template instruction handed to the ORIGINAL agent through the dispatcher, never auto-run here. */
  instruction: string
  /** Acceptance criteria that must be re-verified after the repair. */
  revalidateCriteria: number[]
  /** Every attempt must state a new verifiable hypothesis — never "try again". */
  requiresNewHypothesis: true
  rationale: string
}

export interface SelfHealPlanFacts {
  schemaVersion: 1
  taskId: string
  fingerprint: string
  attempt: number
  maxAttempts: number
  limitReached: boolean
  /** false when no repair is warranted or the attempt limit is exhausted. */
  available: boolean
  ok: boolean
  code: 'CAPABILITY_UNAVAILABLE' | 'ATTEMPT_LIMIT_REACHED' | 'NO_REPAIR_NEEDED' | null
  writeMode: { enabled: boolean; blockedByGates: string[] }
  /** This module never executes anything; dispatching is the dispatcher's job. */
  executed: false
  /** True only when the gate is open AND the fingerprint limit is not reached. */
  dispatchAllowed: boolean
  blockedByGates: string[]
  candidates: SelfHealCandidateFacts[]
  revalidateCriteria: number[]
  gaps: string[]
  /** Why the loop must stop / must not widen. */
  stoppedBecause: string[]
  note: string
  generatedAt: string
}

export interface SelfHealInput {
  verification: VerifyResultFacts
  writeMode: { enabled: boolean; blockedByGates: string[] }
  maxAttempts?: number
  now?: () => number
}

const SCOPE_NOTE =
  'repairs may not widen the original task file/resource scope; a refactor-level change, external side effect, user intervention or permission change stops auto-repair'

/**
 * Build the limited self-heal plan. Pure: no I/O, no ledger write, no dispatch.
 */
export function planSelfHeal(input: SelfHealInput): SelfHealPlanFacts {
  const verification = input.verification
  const writeMode = {
    enabled: input.writeMode.enabled === true,
    blockedByGates: Array.isArray(input.writeMode.blockedByGates) ? [...input.writeMode.blockedByGates] : [],
  }
  const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_HEAL_ATTEMPT_LIMIT)
  const stoppedBecause: string[] = []
  const candidates: SelfHealCandidateFacts[] = []
  const base = {
    schemaVersion: SELF_HEAL_SCHEMA_VERSION,
    taskId: verification.taskId,
    fingerprint: verification.fingerprint,
    attempt: verification.attempt,
    maxAttempts,
    limitReached: verification.limitReached || verification.attempt >= maxAttempts,
    writeMode,
    executed: false as const,
    gaps: [...verification.gaps],
    stoppedBecause,
    generatedAt: new Date((input.now ?? Date.now)()).toISOString(),
  }

  if (verification.conclusion === 'passed') {
    return {
      ...base,
      available: false,
      ok: false,
      code: 'NO_REPAIR_NEEDED',
      dispatchAllowed: false,
      blockedByGates: writeMode.blockedByGates,
      candidates: [],
      revalidateCriteria: [],
      note: 'verification passed; nothing to repair. The controller may record the verification result.',
    }
  }

  if (base.limitReached) {
    stoppedBecause.push(
      `failure fingerprint ${verification.fingerprint} already used ${verification.attempt}/${maxAttempts} auto-repair attempt(s); the limit stops further dispatch/self-heal (AT-18)`,
    )
    return {
      ...base,
      available: false,
      ok: false,
      code: 'ATTEMPT_LIMIT_REACHED',
      dispatchAllowed: false,
      blockedByGates: writeMode.blockedByGates,
      candidates: [],
      revalidateCriteria: [],
      note: 'the task state is preserved; a human must decide the next move. BOOP will not retry the same fingerprint.',
    }
  }

  /* ── repairs for failed criteria (a new hypothesis per criterion) ─────── */
  const failed = verification.criteria.filter((criterion) => criterion.outcome === 'failed').map((criterion) => criterion.index)
  for (const index of failed) {
    const criterion = verification.criteria[index]
    candidates.push({
      id: `fix:criterion:${index}`,
      kind: 'fix',
      target: `criterion:${index}`,
      instruction:
        `针对验收项「${criterion.text}」提出一个新的、可验证的修复假设并实施最小改动；` +
        `不得扩大原任务的文件/资源范围，不得引入外部副作用；完成后重新验证该项。`,
      revalidateCriteria: [index],
      requiresNewHypothesis: true,
      rationale: 'the acceptance criterion currently fails its recorded check result',
    })
  }

  /* ── stale evidence must be refreshed before any pass is possible (AT-17) ─ */
  const stale = verification.evidence.filter((entry) => entry.staleReason !== null)
  for (const entry of stale) {
    candidates.push({
      id: `refresh-evidence:${entry.ref}`,
      kind: 'refresh-evidence',
      target: `evidence:${entry.ref}`,
      instruction:
        `证据 ${entry.ref} 与目标版本不匹配（${entry.staleReason ?? 'stale'}）；` +
        `请在目标版本上重新产生可验证证据，并用同一验收标准复核；不要用过期证据声称通过。`,
      revalidateCriteria: verification.criteria.map((criterion) => criterion.index),
      requiresNewHypothesis: true,
      rationale: 'evidence produced for another version/generation cannot close this task',
    })
  }

  /* ── uncovered criteria need more evidence, not a blind fix ───────────── */
  for (const index of verification.uncovered.slice(0, 8)) {
    const criterion = verification.criteria[index]
    candidates.push({
      id: `investigate:criterion:${index}`,
      kind: 'investigate',
      target: `criterion:${index}`,
      instruction:
        `验收项「${criterion.text}」尚无可用证据；请收集与目标版本一致的测试结果、交互核查或产物证据，` +
        `并说明未覆盖项；不要以口头完成代替证据。`,
      revalidateCriteria: [index],
      requiresNewHypothesis: true,
      rationale: 'the criterion has no covering evidence yet',
    })
  }

  /* ── claims-only / no durable evidence needs a human or evidence request ─ */
  if (verification.claimObserved && verification.evidence.every((entry) => entry.agentClaim || !entry.resolved)) {
    candidates.push({
      id: 'ask-user:evidence',
      kind: 'ask-user',
      target: 'evidence',
      instruction:
        '当前只有 Agent 自述或无法解析的证据地址；请提供可回查的证据（测试名称/结果、精确提交或交互核查），' +
        '或由用户明确选择跳过验收（verification=waived 并记录理由）。',
      revalidateCriteria: verification.criteria.map((criterion) => criterion.index),
      requiresNewHypothesis: true,
      rationale: 'an Agent claim is never acceptance evidence (AT-16)',
    })
  } else if (verification.evidence.length === 0) {
    candidates.push({
      id: 'investigate:evidence',
      kind: 'investigate',
      target: 'evidence',
      instruction: '任务尚无任何持久证据；请在目标版本上先产生证据，再请求验收。',
      revalidateCriteria: verification.criteria.map((criterion) => criterion.index),
      requiresNewHypothesis: true,
      rationale: 'no durable evidence exists for this task',
    })
  }

  if (verification.criteria.length === 0) {
    stoppedBecause.push('the task has no acceptance criteria; verification cannot be repaired by code changes')
    candidates.push({
      id: 'ask-user:criteria',
      kind: 'ask-user',
      target: 'criteria',
      instruction: '该任务尚未记录验收标准；请用户补充完成标准后再验收，不要自行发明验收。',
      revalidateCriteria: [],
      requiresNewHypothesis: true,
      rationale: 'verification follows the original user standard, not an invented one',
    })
  }

  if (!writeMode.enabled) {
    stoppedBecause.push(`write mode is closed (blocked by ${writeMode.blockedByGates.join(', ') || 'unknown gates'}); only the preview is produced`)
  }

  const dispatchAllowed = writeMode.enabled && candidates.length > 0 && !base.limitReached
  const revalidateCriteria = [...new Set(candidates.flatMap((candidate) => candidate.revalidateCriteria))].sort((a, b) => a - b)

  return {
    ...base,
    available: candidates.length > 0,
    ok: writeMode.enabled && candidates.length > 0,
    code: writeMode.enabled ? (candidates.length > 0 ? null : 'NO_REPAIR_NEEDED') : 'CAPABILITY_UNAVAILABLE',
    dispatchAllowed,
    blockedByGates: writeMode.blockedByGates,
    candidates,
    revalidateCriteria,
    note: writeMode.enabled
      ? 'preview only: BOOP never dispatches from this module; the controller must route any repair through the single dispatcher write path and re-verify afterwards.'
      : `preview only (executed:false): write mode is closed; blocked by ${writeMode.blockedByGates.join(', ') || 'unknown gates'}. No repair was dispatched.`,
  }
}

/** Rendered copy for the UI/model; states the limits instead of promising success. */
export function renderSelfHealPlan(plan: SelfHealPlanFacts): string {
  const head =
    plan.code === 'ATTEMPT_LIMIT_REACHED'
      ? `同一失败指纹已尝试 ${plan.attempt}/${plan.maxAttempts} 次，停止自动修复与继续派发。`
      : plan.code === 'CAPABILITY_UNAVAILABLE'
        ? `修复预览已生成（未执行、未派发）：写模式关闭（${plan.blockedByGates.join(', ') || '门禁未通过'}）。`
        : plan.code === 'NO_REPAIR_NEEDED'
          ? '无需修复。'
          : `修复预览已生成（未执行、未派发），共 ${plan.candidates.length} 个候选。`
  const body = plan.candidates
    .slice(0, 6)
    .map((candidate) => `${candidate.id} → ${candidate.target}（重新验证：${candidate.revalidateCriteria.join(',') || '无'}）`)
    .join('\n')
  return [head, body, plan.note].filter((line) => line !== '').join('\n')
}

/** Shared contract note reused by tests/evidence: repairing never widens scope. */
export const SELF_HEAL_SCOPE_NOTE = SCOPE_NOTE

/** Version marker so a client can refuse an incompatible future shape. */
export const SELF_HEAL_VERSION = VERIFY_SCHEMA_VERSION

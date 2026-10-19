/**
 * BOOP human-control surfaces (E04-03 client half): approvals, deterministic
 * Stop, restart-recovery release, unknown results — plus the main-Session
 * approval badge.
 *
 * Contract by task-9 (Host half `boopControl`, finalised 2026-10-18; real JSON
 * fixtures in `.work/control-fixtures.json`; single-layer `result.value`,
 * `{args:{request:{...}}}` wire). Every statement in this UI is tied to a Host
 * fact:
 *  - a decision is only shown as "服务端已记录：允许/拒绝本次（仅落账）" after the
 *    server's own receipt said `accepted` with that outcome AND its
 *    `executed:false`/`dispatched:false` facts; nothing is optimistically
 *    flipped locally (04§08: decision ≠ dispatch);
 *  - an idempotent `already-handled` reply is shown as "已在别处处理", never as
 *    a new approval (FE-06/AT-28);
 *  - an invalid/stale approval is rendered with the exact server reason and its
 *    action buttons stay disabled (`canDecide`), while the read-only ledger case
 *    is explained instead of silently disabled;
 *  - Stop is deterministic and scoped; the three Host buckets keep distinct
 *    meanings — stopped (BOOP 尚未投递的待发动作已取消) / refused (已投递或已终结：
 *    BOOP 不宣称撤销，去原 Session 停) / unknown (待确认、不重试) — and the
 *    permanent strip says "请求已发送 ≠ 外部副作用已撤销" (FE-07/AT-30); a
 *    `noop` reply reads "没有可停止内容", not success;
 *  - release is explicit: no default selection, no select-all, only the exact
 *    messageIds the human checked (G04/AT-26); the Host's
 *    `runtimeEnforcement.composed:false` is displayed honestly (release only
 *    moves the gate ledger, not the runtime);
 *  - unavailable/unknown/partial/offline are honest (FE-11): a failed read is
 *    never an empty list, and unknown results are never auto-retried or marked
 *    done;
 *  - all controls are native buttons/inputs/selects with labels, visible focus,
 *    >=32px targets and focus moved to the result receipt after an async action
 *    (TB08/FE-08); styles are BOOP-scoped and removed on unmount (FE-12).
 */
import React from 'react'
import { installControlStyles } from './control-styles.ts'
import {
  DECISION_RESULT_WARNING,
  RECOVERY_WARNING,
  STOP_RESULT_WARNING,
  approvalBindingSummary,
  approvalInvalidReasonLabel,
  approvalStateLine,
  approvalStatusLabel,
  buildDecisionRequest,
  buildReleaseRequest,
  buildStopRequest,
  createRequestGuard,
  fetchApprovals,
  fetchControlState,
  isStaleProjection,
  refusedItemLine,
  staleCauseLabel,
  stoppedItemLine,
  submitDecision,
  submitRelease,
  submitStop,
  unknownItemLine,
  type ApprovalFacts,
  type ControlActionFacts,
  type ControlCall,
  type ControlCommandOutcome,
  type ControlFetchResult,
  type ControlStateFacts,
  type DecisionFacts,
  type RecoveryEntryFacts,
  type RecoveryGateFacts,
  type ReleaseFacts,
  type StopFacts,
  type StopScopeKind,
} from './control-model.ts'

export interface BoopControlPanelProps {
  call: ControlCall
  onOpenSession?: (sessionId: string) => void
}

type StateLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; facts: ControlStateFacts }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; message: string }

type ApprovalFeedback = {
  phase: 'submitting' | 'info' | 'idempotent' | 'error'
  message: string
  code: string | null
  audit: string | null
  /** true = a server outcome exists; the card must not be re-submittable. */
  decided: boolean
}

type StopOutcome = ControlCommandOutcome<StopFacts>
type ReleaseOutcome = ControlCommandOutcome<ReleaseFacts>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Audit receipt suffix, or '' when the Host did not report one. */
function auditLine(audit: {
  recorded: boolean
  sink: string
  id: string | null
  kind?: string | null
  note?: string | null
} | null | undefined): string {
  if (!audit) return ''
  const kind = audit.kind ? ` ${audit.kind}` : ''
  return `审计：${audit.sink}${audit.recorded ? '，已记录' : '，未记录'}${audit.id ? `（${audit.id}）` : ''}${kind}`
}

/** Defer focus to after React commits the receipt (keeps keyboard context). */
function focusAfterCommit(id: string): void {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return
  setTimeout(() => {
    const node = document.getElementById(id)
    if (node && typeof (node as HTMLElement).focus === 'function') (node as HTMLElement).focus()
  }, 0)
}

/** Tone for one approval badge; only a decidable pending row is actionable. */
function approvalTone(approval: ApprovalFacts): 'ok' | 'warn' | 'bad' | 'muted' {
  if (approval.status === 'pending') return approval.canDecide ? 'warn' : approval.valid ? 'muted' : 'bad'
  if (approval.status === 'allowed' || approval.status === 'rejected') return 'ok'
  if (approval.status === 'expired' || approval.status === 'stale') return 'bad'
  return 'muted'
}

function decisionOutcomeLabel(facts: DecisionFacts): string {
  switch (facts.outcome) {
    case 'allowed':
      return '允许本次（仅落账）'
    case 'rejected':
      return '拒绝本次（仅落账）'
    default:
      return facts.outcome
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * BoopControlPanel — the one additive control area in the BOOP panel
 * ══════════════════════════════════════════════════════════════════════ */

export function BoopControlPanel({ call, onOpenSession }: BoopControlPanelProps): React.ReactElement {
  const callRef = React.useRef(call)
  callRef.current = call

  // Scoped styles live exactly as long as this panel (FE-12).
  React.useEffect(() => installControlStyles(), [])

  const [load, setLoad] = React.useState<StateLoad>({ kind: 'loading' })
  const [refreshing, setRefreshing] = React.useState(false)
  const [staleNotice, setStaleNotice] = React.useState<string | null>(null)
  const [feedback, setFeedback] = React.useState<Record<string, ApprovalFeedback>>({})
  const [stopKind, setStopKind] = React.useState<StopScopeKind>('all')
  const [stopId, setStopId] = React.useState('')
  const [stopBusy, setStopBusy] = React.useState(false)
  const [stopOutcome, setStopOutcome] = React.useState<StopOutcome | null>(null)
  const [releaseSelected, setReleaseSelected] = React.useState<Set<string>>(() => new Set())
  const [releaseBusy, setReleaseBusy] = React.useState(false)
  const [releaseOutcome, setReleaseOutcome] = React.useState<ReleaseOutcome | null>(null)

  const loadGuard = React.useRef(createRequestGuard())
  const lastProjectionSeq = React.useRef<number | null>(null)

  const refresh = React.useCallback(async (): Promise<void> => {
    const seq = loadGuard.current.next()
    setRefreshing(true)
    const result = await fetchControlState(callRef.current)
    if (!loadGuard.current.isLatest(seq)) {
      setStaleNotice(`已丢弃一个较旧的控制面响应（请求 #${seq}）：保留较新的状态（AT-19/FE-04）。`)
      setRefreshing(false)
      return
    }
    if (!result.ok || result.facts === null) {
      setLoad({ kind: 'error', message: result.error ?? '控制面读取失败' })
      setRefreshing(false)
      return
    }
    const facts = result.facts
    if (isStaleProjection(facts.projectionSeq, lastProjectionSeq.current)) {
      setStaleNotice(
        `已丢弃投影序号更旧的控制面响应（projectionSeq ${facts.projectionSeq} < ${lastProjectionSeq.current}）：保留较新的状态。`,
      )
      setRefreshing(false)
      return
    }
    if (facts.projectionSeq !== null) lastProjectionSeq.current = facts.projectionSeq
    if (!result.unavailable) {
      setLoad({ kind: 'ready', facts })
      // Keep only selections that are still releasable; never add any.
      const releasable = new Set(
        facts.recovery.entries.filter((entry) => entry.releasable).map((entry) => entry.messageId),
      )
      setReleaseSelected((current) => {
        const next = new Set([...current].filter((id) => releasable.has(id)))
        return next.size === current.size ? current : next
      })
    } else {
      setLoad({ kind: 'unavailable', reason: result.reason ?? '宿主报告控制面不可用（未给出原因）' })
    }
    setStaleNotice(null)
    setRefreshing(false)
  }, [])

  React.useEffect(() => {
    void refresh()
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    const onOnline = (): void => {
      void refresh()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [refresh])

  const decide = React.useCallback(
    async (approval: ApprovalFacts, decision: 'approve' | 'reject'): Promise<void> => {
      const current = feedback[approval.approvalId]
      if (current?.phase === 'submitting' || current?.decided === true) return
      if (!approval.canDecide) return
      setFeedback((state) => ({
        ...state,
        [approval.approvalId]: {
          phase: 'submitting',
          message: '正在提交决定；等待服务端逐项校验绑定并回执…',
          code: null,
          audit: null,
          decided: false,
        },
      }))
      const outcome = await submitDecision(callRef.current, buildDecisionRequest(approval, decision))
      const facts = outcome.status === 'error' ? null : (outcome.facts as DecisionFacts)
      const audit = auditLine(facts?.audit ?? null)
      if (outcome.status === 'confirmed' && facts) {
        setFeedback((state) => ({
          ...state,
          [approval.approvalId]: {
            phase: 'info',
            message: `服务端已记录：${decisionOutcomeLabel(facts)}。${facts.message ?? DECISION_RESULT_WARNING}`,
            code: null,
            audit,
            decided: true,
          },
        }))
        await refresh()
      } else if (outcome.status === 'idempotent' && facts) {
        setFeedback((state) => ({
          ...state,
          [approval.approvalId]: {
            phase: 'idempotent',
            message: `${outcome.reason}${facts.existingStatus ? `（existingStatus: ${facts.existingStatus}）` : ''}`,
            code: outcome.code,
            audit,
            decided: true,
          },
        }))
        await refresh()
      } else {
        const staleCause = facts?.staleCause ? staleCauseLabel(facts.staleCause) : null
        const marked = facts?.markedInvalid ? '；服务端已把该审批标记为失效' : ''
        setFeedback((state) => ({
          ...state,
          [approval.approvalId]: {
            phase: 'error',
            message: `${outcome.reason || '服务端没有确认这次决定；没有把它当作已批准。'}${
              staleCause ? `（失效原因：${staleCause}）` : ''
            }${marked}`,
            code: outcome.code ?? facts?.code ?? null,
            audit,
            decided: facts?.markedInvalid === true,
          },
        }))
        if (facts?.markedInvalid) await refresh()
      }
      focusAfterCommit(`boop-decision-${approval.approvalId}`)
    },
    [feedback, refresh],
  )

  const stop = React.useCallback(async (): Promise<void> => {
    setStopBusy(true)
    setStopOutcome(null)
    let outcome: StopOutcome
    try {
      if (stopKind !== 'all' && stopId.trim().length === 0) {
        setStopBusy(false)
        return
      }
      outcome = await submitStop(callRef.current, buildStopRequest(stopKind, stopId))
    } catch (error) {
      outcome = { status: 'error', facts: null, reason: errorMessage(error), code: null }
    }
    setStopOutcome(outcome)
    setStopBusy(false)
    if (outcome.status === 'confirmed') await refresh()
    focusAfterCommit('boop-stop-result')
  }, [refresh, stopId, stopKind])

  const release = React.useCallback(async (): Promise<void> => {
    const messageIds = [...releaseSelected]
    if (messageIds.length === 0 || releaseBusy) return
    setReleaseBusy(true)
    setReleaseOutcome(null)
    const outcome = await submitRelease(callRef.current, buildReleaseRequest(messageIds))
    setReleaseOutcome(outcome)
    setReleaseBusy(false)
    setReleaseSelected(new Set())
    await refresh()
    focusAfterCommit('boop-release-result')
  }, [refresh, releaseBusy, releaseSelected])

  const facts = load.kind === 'ready' ? load.facts : null
  const pendingApprovals = facts?.pendingApprovals ?? []
  const invalidApprovals = facts?.invalidApprovals ?? []
  const decidableApprovals = pendingApprovals.filter((approval) => approval.canDecide)
  const blockedApprovals = [...pendingApprovals.filter((approval) => !approval.canDecide), ...invalidApprovals]
  const recovery: RecoveryGateFacts = facts?.recovery ?? {
    available: false,
    reason: null,
    armed: false,
    entries: [],
    pendingCount: 0,
    releasedCount: 0,
    requiresExplicitSelection: true,
    bulkReleaseDefault: false,
    runtimeEnforcement: { composed: false, detail: null },
  }
  const selectableEntries = recovery.entries.filter((entry) => entry.releasable)
  const unknownResults = facts?.unknownResults ?? []
  const actions = facts?.actions ?? []
  const boopActions = actions.filter((action) => action.ownership === 'boop')
  const taskOptions = [...new Set(boopActions.map((action) => action.taskId).filter((id): id is string => id !== null))]
  const actionOptions = boopActions.map((action) => action.actionId)
  const sessionOptions = [
    ...new Set([
      ...boopActions.map((action) => action.targetSessionId),
      ...recovery.entries.map((entry) => entry.sessionId),
    ].filter((id): id is string => id !== null && id !== '')),
  ]
  const writeMode = facts?.writeMode ?? null
  const ledger = facts?.ledger ?? null
  const dispatch = facts?.dispatch ?? null
  const approvalCounts = facts?.approvalCounts ?? null
  const actionCounts = facts?.actionCounts ?? null
  const stopScopeOptions =
    stopKind === 'task' ? taskOptions : stopKind === 'action' ? actionOptions : stopKind === 'session' ? sessionOptions : []

  return (
    <section className="boop-card">
      <h2>人工控制（审批 / 停止 / 恢复）</h2>
      <div data-boop-control="" data-boop-control-state={load.kind}>
        <div data-boop-control-toolbar="">
          <h3>控制面</h3>
          <span data-boop-control-note="" data-boop-control-write-mode="">
            写模式：
            {load.kind === 'loading'
              ? '读取中'
              : writeMode === null
                ? '未知'
                : writeMode.enabled
                  ? '开启'
                  : `关闭（blockedBy: ${writeMode.blockedByGates.join(', ') || '无'}）`}
            {' '}· 账本：
            {ledger === null
              ? '未知'
              : `${ledger.writable ? '可写' : '只读'}（${ledger.auditSink}${ledger.durable ? '，durable' : '，非 durable'}）`}
            {' '}· 派发：
            {dispatch === null
              ? '未知'
              : dispatch.available
                ? '可用'
                : `不可用（${dispatch.reason ?? '未说明'}；需要模型：${dispatch.requiresModel ? '是' : '否'}）`}
          </span>
          <button type="button" data-boop-control-action="refresh" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? '刷新中…' : '刷新控制面'}
          </button>
        </div>
        <p data-boop-control-note="">
          人工审批决定与确定性 Stop 不依赖模型；审批决定只落账，不执行副作用；恢复释放只改门禁账本。
        </p>

        {load.kind === 'loading' && <p data-boop-control-note="">正在读取审批/动作/恢复状态…</p>}

        {load.kind === 'error' && (
          <div data-boop-control-alert="" role="alert">
            控制面读取失败：{load.message}。没有把失败当作“无待决审批”，也没有把它保留为成功状态。
            <div>
              <button type="button" data-boop-control-action="retry" onClick={() => void refresh()}>
                重试
              </button>
            </div>
          </div>
        )}

        {load.kind === 'unavailable' && (
          <div data-boop-control-alert="" role="alert">
            控制面不可用：{load.reason}。不可用不等于“没有待决审批”或“无可停止内容”。
            <div>
              <button type="button" data-boop-control-action="retry" onClick={() => void refresh()}>
                重新连接
              </button>
            </div>
          </div>
        )}

        {staleNotice && (
          <p data-boop-control-note="" data-boop-control-stale="" role="status">
            {staleNotice}
          </p>
        )}
        {facts?.truncated === true && (
          <p data-boop-control-note="" data-boop-control-truncated="" role="status">
            宿主报告列表已截断（读取上限 {facts.limits.listMax ?? '未知'}）：当前控制面只覆盖部分审批/动作；未显示的条目不会被当作不存在。
          </p>
        )}

        {/* ── approvals ─────────────────────────────────────────────── */}
        <div data-boop-approvals="">
          <h3>待决审批</h3>
          {approvalCounts && (
            <p data-boop-control-note="" data-boop-approval-counts="">
              待决 {approvalCounts.pending}（可决定 {approvalCounts.validPending}，失效{' '}
              {approvalCounts.invalidPending}）；已批准 {approvalCounts.allowed}，已拒绝 {approvalCounts.rejected}，
              已过期 {approvalCounts.expired}，失效 {approvalCounts.stale}。
            </p>
          )}
          {load.kind === 'ready' && decidableApprovals.length === 0 && (
            <p data-boop-control-note="" role="status">
              {pendingApprovals.length === 0
                ? '服务端确认：当前没有等待你决定的有效审批（不是读取失败）。'
                : '当前没有可直接决定的审批：其余审批已失效或账本只读（见下方原因）。'}
            </p>
          )}
          {decidableApprovals.map((approval) => (
            <ApprovalCard
              key={approval.approvalId}
              approval={approval}
              feedback={feedback[approval.approvalId] ?? null}
              onDecide={(decision) => void decide(approval, decision)}
              onOpenSession={onOpenSession}
            />
          ))}
          {blockedApprovals.length > 0 && (
            <>
              <h4 data-boop-control-note="">已失效 / 已处理 / 暂不可决定（不可再次决定）</h4>
              {blockedApprovals.map((approval) => (
                <ApprovalCard
                  key={approval.approvalId}
                  approval={approval}
                  feedback={feedback[approval.approvalId] ?? null}
                  onDecide={() => undefined}
                  onOpenSession={onOpenSession}
                />
              ))}
            </>
          )}
        </div>

        {/* ── unknown results ───────────────────────────────────────── */}
        <UnknownResultsSection
          unknownResults={unknownResults}
          available={load.kind === 'ready'}
          onOpenSession={onOpenSession}
        />

        {/* ── stop: deterministic, always available (model-independent) ── */}
        <div data-boop-stop="">
          <h3>停止 BOOP 动作</h3>
          {actionCounts && (
            <p data-boop-control-note="" data-boop-action-counts="">
              动作 {actionCounts.total}：待发 {actionCounts.pending}，已投递 {actionCounts.accepted}，未知{' '}
              {actionCounts.unknown}，阻塞 {actionCounts.blocked}，已取消 {actionCounts.cancelled}。
            </p>
          )}
          <div data-boop-stop-scope="" role="group" aria-label="停止范围">
            {(
              [
                ['all', '全部 BOOP 动作'],
                ['task', '某任务'],
                ['action', '某动作'],
                ['session', '某会话'],
              ] as const
            ).map(([kind, label]) => (
              <label key={kind}>
                <input
                  type="radio"
                  name="boop-stop-scope"
                  value={kind}
                  checked={stopKind === kind}
                  onChange={() => {
                    setStopKind(kind)
                    setStopId('')
                  }}
                />
                {label}
              </label>
            ))}
            {stopKind !== 'all' && (
              <select
                aria-label={
                  stopKind === 'task' ? '选择要停止的任务' : stopKind === 'action' ? '选择要停止的动作' : '选择要停止的会话'
                }
                value={stopId}
                onChange={(event) => setStopId(event.target.value)}
                disabled={stopScopeOptions.length === 0 || stopBusy}
              >
                <option value="">
                  {stopScopeOptions.length === 0
                    ? '没有读取到可选项（仍可发送“全部 BOOP 动作”）'
                    : `选择${stopKind === 'task' ? '任务' : stopKind === 'action' ? '动作' : '会话'}…`}
                </option>
                {stopScopeOptions.map((option) => (
                  <option key={option} value={option}>
                    {`${stopKind === 'task' ? '任务' : stopKind === 'action' ? '动作' : '会话'} ${option}`}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              data-boop-stop-action="stop"
              data-tone="danger"
              disabled={stopBusy || (stopKind !== 'all' && stopId.trim().length === 0)}
              onClick={() => void stop()}
            >
              {stopBusy ? '正在发送停止请求…' : stopKind === 'all' ? '停止全部 BOOP 动作' : '停止所选范围'}
            </button>
          </div>
          <p data-boop-control-warning="">
            只停 BOOP 自有动作/outbox（不需要模型）；用户自己的 turn 不会被停。{STOP_RESULT_WARNING}
          </p>
          {load.kind !== 'ready' && (
            <p data-boop-control-note="">
              当前没有可读的动作列表，但确定性 Stop 仍可发送；结果会如实显示逐项/未知状态。
            </p>
          )}
          {stopBusy && (
            <p data-boop-control-note="" role="status">
              停止请求已发送，等待服务端逐项结果；尚未结算的部分会显示为未知，不会当作已撤销。
            </p>
          )}
          {stopOutcome && <StopResult id="boop-stop-result" outcome={stopOutcome} onOpenSession={onOpenSession} />}
        </div>

        {/* ── recovery ─────────────────────────────────────────────── */}
        <div data-boop-recovery="">
          <h3>重启恢复核查</h3>
          <p data-boop-control-note="" data-boop-recovery-status="">
            {load.kind === 'ready'
              ? recovery.available
                ? `门禁已装备（fail-closed）：待释放 ${recovery.pendingCount} 条，已释放 ${recovery.releasedCount} 条。`
                : `恢复门禁不可用：${recovery.reason ?? '未给出原因'}。`
              : '恢复门禁：未知（控制面不可读）'}
            {' '}
            {RECOVERY_WARNING}
          </p>
          {recovery.runtimeEnforcement.composed === false && (
            <p data-boop-control-warning="" data-boop-runtime-enforcement="not-composed">
              运行时前置门控未接线：释放只改变门禁账本，不代表 agent/pre-step 运行时已放行。
              {recovery.runtimeEnforcement.detail ? ` ${recovery.runtimeEnforcement.detail}` : ''}
            </p>
          )}
          {load.kind === 'ready' && recovery.available && recovery.entries.length === 0 && (
            <p data-boop-control-note="" role="status">
              服务端确认：当前没有需要恢复核查的旧 BOOP 命令。
            </p>
          )}
          {recovery.entries.map((entry) => (
            <RecoveryEntryRow
              key={entry.messageId}
              entry={entry}
              selected={releaseSelected.has(entry.messageId)}
              disabled={releaseBusy}
              onToggle={(checked) => {
                setReleaseSelected((current) => {
                  const next = new Set(current)
                  if (checked) next.add(entry.messageId)
                  else next.delete(entry.messageId)
                  return next
                })
              }}
              onOpenSession={onOpenSession}
            />
          ))}
          <div>
            <button
              type="button"
              data-boop-recovery-action="release"
              data-tone="primary"
              disabled={releaseSelected.size === 0 || releaseBusy}
              onClick={() => void release()}
            >
              {releaseBusy ? '正在释放…' : `释放选中（${releaseSelected.size}）`}
            </button>
          </div>
          {releaseSelected.size === 0 && selectableEntries.length > 0 && (
            <p data-boop-control-note="">没有默认选中任何条目；必须逐项勾选后才会释放。</p>
          )}
          {releaseOutcome && <ReleaseResult id="boop-release-result" outcome={releaseOutcome} />}
        </div>
      </div>
    </section>
  )
}

/* ── approval card ────────────────────────────────────────────────────── */

function ApprovalCard({
  approval,
  feedback,
  onDecide,
  onOpenSession,
}: {
  approval: ApprovalFacts
  feedback: ApprovalFeedback | null
  onDecide: (decision: 'approve' | 'reject') => void
  onOpenSession?: (sessionId: string) => void
}): React.ReactElement {
  const busy = feedback?.phase === 'submitting'
  const decided = feedback?.decided === true
  const disabled = !approval.canDecide || busy || decided
  const receiptId = `boop-decision-${approval.approvalId}`
  return (
    <article
      data-boop-approval=""
      data-approval-id={approval.approvalId}
      data-status={approval.status}
      data-valid={approval.valid ? 'true' : 'false'}
      data-can-decide={approval.canDecide ? 'true' : 'false'}
    >
      <div data-boop-approval-title="">
        <span>审批 {approval.approvalId}</span>
        <span data-boop-approval-badge="" data-tone={approvalTone(approval)}>
          {approvalStatusLabel(approval.status)}
        </span>
        {approval.decision !== null && (
          <span data-boop-approval-badge="" data-tone="muted">
            决定：{approval.decision === 'allowed' ? '允许' : '拒绝'}
          </span>
        )}
        {approval.invalidReason !== null && (
          <span data-boop-approval-badge="" data-tone="bad">
            {approvalInvalidReasonLabel(approval.invalidReason)}
          </span>
        )}
        {approval.consumedAt !== null && (
          <span data-boop-approval-badge="" data-tone="muted">
            已在别处处理
          </span>
        )}
      </div>
      <div data-boop-approval-binding="">{approvalBindingSummary(approval)}</div>
      <p data-boop-control-note="">{approvalStateLine(approval)}</p>
      {approval.expiresAt !== null && <p data-boop-control-note="">绑定过期时间：{approval.expiresAt}</p>}
      <div data-boop-approval-actions="">
        <button
          type="button"
          data-boop-approval-action="approve"
          data-tone="primary"
          disabled={disabled}
          aria-label={`批准本次审批 ${approval.approvalId}（只记录审批结论，不执行动作）`}
          onClick={() => onDecide('approve')}
        >
          批准本次
        </button>
        <button
          type="button"
          data-boop-approval-action="reject"
          data-tone="danger"
          disabled={disabled}
          aria-label={`拒绝本次审批 ${approval.approvalId}`}
          onClick={() => onDecide('reject')}
        >
          拒绝
        </button>
        {approval.targetSessionId && onOpenSession && (
          <button
            type="button"
            data-boop-approval-action="open-session"
            aria-label={`打开相关会话 ${approval.targetSessionId}`}
            onClick={() => {
              const exact = approval.targetSessionId
              if (exact) onOpenSession(exact)
            }}
          >
            打开相关会话
          </button>
        )}
        {busy && (
          <span data-boop-control-note="" role="status">
            正在提交决定；服务端未回执前不会显示任何结果。
          </span>
        )}
      </div>
      {feedback && (feedback.phase === 'info' || feedback.phase === 'idempotent' || feedback.phase === 'error') && (
        <div
          id={receiptId}
          tabIndex={-1}
          data-boop-control-receipt=""
          data-tone={feedback.phase === 'error' ? 'bad' : feedback.phase === 'idempotent' ? 'warn' : 'ok'}
          role={feedback.phase === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
          {feedback.code ? `（code: ${feedback.code}）` : ''}
          {feedback.audit ? ` ${feedback.audit}` : ''}
        </div>
      )}
    </article>
  )
}

/* ── stop result ──────────────────────────────────────────────────────── */

function StopResult({
  id,
  outcome,
  onOpenSession,
}: {
  id: string
  outcome: StopOutcome
  onOpenSession?: (sessionId: string) => void
}): React.ReactElement {
  if (outcome.status === 'error') {
    return (
      <div id={id} tabIndex={-1} data-boop-stop-result="" data-boop-control-receipt="" data-tone="bad" role="alert">
        停止请求失败：{outcome.reason}。没有把它显示成已停止。
      </div>
    )
  }
  const facts = outcome.facts
  if (facts === null) {
    return (
      <div id={id} tabIndex={-1} data-boop-stop-result="" data-boop-control-receipt="" data-tone="bad" role="alert">
        停止请求没有被服务端确认：{outcome.reason}
        {outcome.code ? `（code: ${outcome.code}）` : ''}
      </div>
    )
  }
  const confirmed = outcome.status === 'confirmed'
  return (
    <div
      id={id}
      tabIndex={-1}
      data-boop-stop-result=""
      data-boop-control-receipt=""
      data-tone={confirmed ? 'ok' : 'bad'}
      role="status"
      data-accepted={facts.accepted ? 'true' : 'false'}
      data-noop={facts.noop ? 'true' : 'false'}
    >
      <p data-boop-control-note="">
        服务端{facts.accepted ? '已受理停止请求' : '未确认停止请求'}（确定性：{facts.deterministic ? '是' : '未知'}；需要模型：
        {facts.requiresModel ? '是' : '否'}）。
        {facts.noop
          ? '没有可停止内容（noop=true，stopped 为空，不是“已撤销成功”）。'
          : `匹配 ${facts.matched} 项：已停止 ${facts.summary?.stopped ?? facts.stopped.length}，未停止 ${
              facts.summary?.refused ?? facts.refused.length
            }，待确认 ${facts.summary?.unknown ?? facts.unknown.length}。`}
        {facts.requestedScope ? ` 范围：${facts.requestedScope.raw}。` : ''}
        {facts.message ? ` 服务端说明：${facts.message}` : ''}
        {!confirmed ? ` 未确认原因：${outcome.reason}${outcome.code ? `（${outcome.code}）` : ''}` : ''}
      </p>

      {facts.stopped.length > 0 && (
        <>
          <h4 data-boop-control-note="">已停止（BOOP 尚未投递的待发动作/outbox 已取消）</h4>
          {facts.stopped.map((item) => (
            <div key={item.actionId} data-boop-stop-item="" data-tone="ok">
              {stoppedItemLine(item)}
            </div>
          ))}
        </>
      )}

      {facts.refused.length > 0 && (
        <>
          <h4 data-boop-control-note="">未停止（已投递或已终结：BOOP 不宣称撤销，请到原会话用原生 Stop）</h4>
          {facts.refused.map((item) => (
            <div key={item.actionId} data-boop-stop-item="" data-tone="bad">
              {refusedItemLine(item)}
              {item.targetSessionId && onOpenSession && (
                <button
                  type="button"
                  data-boop-stop-action="open-session"
                  aria-label={`打开动作原会话 ${item.targetSessionId}`}
                  onClick={() => {
                    const exact = item.targetSessionId
                    if (exact) onOpenSession(exact)
                  }}
                >
                  打开原会话
                </button>
              )}
            </div>
          ))}
        </>
      )}

      {facts.unknown.length > 0 && (
        <>
          <h4 data-boop-control-note="">结果待确认（不重试、不显示为已停止）</h4>
          {facts.unknown.map((item) => (
            <div key={item.actionId} data-boop-stop-item="" data-tone="warn">
              {unknownItemLine(item)}
            </div>
          ))}
        </>
      )}

      {facts.policy && (
        <p data-boop-control-note="" data-boop-stop-policy="">
          策略事实：ownOnly={facts.policy.ownsOnly}；用户 turn 被停=
          {facts.policy.userTurnsStopped ? '是（异常）' : '否'}；外部副作用已撤销=
          {facts.policy.externalSideEffectsUndone ? '是（异常）' : '否'}；确定性={facts.policy.deterministic ? '是' : '否'}；
          需要模型={facts.policy.requiresModel ? '是' : '否'}。
        </p>
      )}
      {facts.truncated && (
        <p data-boop-control-warning="" data-boop-stop-truncated="">
          动作读取到达上限（部分范围）：还有未覆盖的动作，本结果不是全部动作的停止结论。
        </p>
      )}
      <p data-boop-control-warning="">{STOP_RESULT_WARNING}</p>
      {facts.audit ? <p data-boop-control-note="">{auditLine(facts.audit)}</p> : null}
    </div>
  )
}

/* ── recovery entry + release result ──────────────────────────────────── */

function RecoveryEntryRow({
  entry,
  selected,
  disabled,
  onToggle,
  onOpenSession,
}: {
  entry: RecoveryEntryFacts
  selected: boolean
  disabled: boolean
  onToggle: (checked: boolean) => void
  onOpenSession?: (sessionId: string) => void
}): React.ReactElement {
  const released = entry.state === 'released'
  const selectable = entry.releasable && !released
  return (
    <label data-boop-recovery-entry="" data-state={released ? 'released' : entry.state} data-message-id={entry.messageId}>
      <input
        type="checkbox"
        checked={selected}
        disabled={!selectable || disabled}
        aria-label={`释放旧 BOOP 命令 ${entry.messageId}`}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <span>
        {released ? '已释放（门禁账本）' : selectable ? '保持阻断' : '不可释放'} · 消息 {entry.messageId} · 动作{' '}
        {entry.actionId || '未知'} · 会话 {entry.sessionId || '未知'}
        {entry.reason ? ` · ${entry.reason}` : ''}
        {entry.sessionId && onOpenSession && (
          <button
            type="button"
            data-boop-recovery-action="open-session"
            aria-label={`打开恢复条目所在会话 ${entry.sessionId}`}
            onClick={(event) => {
              event.preventDefault()
              const exact = entry.sessionId
              if (exact) onOpenSession(exact)
            }}
          >
            打开会话
          </button>
        )}
      </span>
    </label>
  )
}

function ReleaseResult({ id, outcome }: { id: string; outcome: ReleaseOutcome }): React.ReactElement {
  if (outcome.status === 'error' || outcome.facts === null) {
    return (
      <div id={id} tabIndex={-1} data-boop-release-result="" data-boop-control-receipt="" data-tone="bad" role="alert">
        释放请求失败：{outcome.reason}。没有把它显示成已释放。
      </div>
    )
  }
  const facts = outcome.facts
  const confirmed = outcome.status === 'confirmed'
  return (
    <div
      id={id}
      tabIndex={-1}
      data-boop-release-result=""
      data-boop-control-receipt=""
      data-tone={confirmed ? 'ok' : 'bad'}
      role="status"
    >
      <p data-boop-control-note="">
        服务端回执：{facts.accepted ? '已受理' : '未确认'}；请求释放 {facts.requestedMessageIds.length} 项，已释放{' '}
        {facts.released.length} 项
        {facts.released.length > 0 ? `（${facts.released.map((item) => item.messageId).join('、')}）` : ''}
        ，忽略 {facts.ignored.length} 项
        {facts.ignored.length > 0
          ? `（${facts.ignored.map((item) => `${item.messageId}：${item.reason}`).join('；')}）`
          : ''}
        。未勾选的条目仍保持阻断，没有自动放行。
        {facts.code ? ` code: ${facts.code}。` : ''}
        {facts.message ? ` ${facts.message}` : ''}
        {!confirmed ? ` 未确认原因：${outcome.reason}` : ''}
      </p>
      {facts.audit ? <p data-boop-control-note="">{auditLine(facts.audit)}</p> : null}
    </div>
  )
}

/* ── unknown results ──────────────────────────────────────────────────── */

function UnknownResultsSection({
  unknownResults,
  available,
  onOpenSession,
}: {
  unknownResults: ControlActionFacts[]
  available: boolean
  onOpenSession?: (sessionId: string) => void
}): React.ReactElement {
  return (
    <div data-boop-unknown-results="">
      <h3>结果未知（需人工核查）</h3>
      {!available && <p data-boop-control-note="">控制面不可读：无法确认是否存在未知结果，未当作“没有”。</p>}
      {available && unknownResults.length === 0 && (
        <p data-boop-control-note="" role="status">
          服务端确认：当前没有结果未知的动作。
        </p>
      )}
      {unknownResults.length > 0 && (
        <ul>
          {unknownResults.map((result) => (
            <li key={result.actionId} data-boop-unknown-result={result.actionId}>
              动作 {result.actionId} · 任务 {result.taskId ?? '未知'} · 会话 {result.targetSessionId ?? '未知'}：
              结果待确认（{result.state}，不会自动重试，也不会标记完成）。
              {result.targetSessionId && onOpenSession && (
                <button
                  type="button"
                  data-boop-unknown-action="open-session"
                  aria-label={`打开结果未知动作所在会话 ${result.targetSessionId}`}
                  onClick={() => {
                    const exact = result.targetSessionId
                    if (exact) onOpenSession(exact)
                  }}
                >
                  打开会话核查
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ── main-Session header badge (additive, count only) ─────────────────── */

export interface BoopApprovalBadgeProps {
  call: ControlCall
  onOpenBoard?: () => void
}

/**
 * A small additive badge for the existing BOOP main-Session header slot.
 * It renders ONLY a real valid-pending count: 0 and unreadable both render
 * nothing (never "0" when the plane failed). The header registration lives in
 * `src/client/index.tsx` (outside this task's write scope); this component is
 * exported so it can be wired there with the existing `call` closure.
 */
export function BoopApprovalBadge({ call, onOpenBoard }: BoopApprovalBadgeProps): React.ReactElement | null {
  const callRef = React.useRef(call)
  callRef.current = call
  React.useEffect(() => installControlStyles(), [])
  const [state, setState] = React.useState<{ count: number | null }>({ count: null })

  const load = React.useCallback(async (): Promise<void> => {
    const result: ControlFetchResult<{ approvals: ApprovalFacts[] }> = await fetchApprovals(callRef.current)
    if (!result.ok || result.unavailable || result.facts === null) {
      setState({ count: null })
      return
    }
    const count = result.facts.approvals.filter(
      (approval) => approval.status === 'pending' && approval.valid,
    ).length
    setState({ count })
  }, [])

  React.useEffect(() => {
    void load()
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    const onOnline = (): void => {
      void load()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [load])

  if (state.count === null || state.count === 0) return null
  return (
    <span data-boop-approval-badge="" data-count={state.count} title="有等待你决定的 BOOP 审批">
      <button
        type="button"
        aria-label={`有 ${state.count} 项待决审批；打开 BOOP 任务板`}
        onClick={() => onOpenBoard?.()}
      >
        待批 {state.count}
      </button>
    </span>
  )
}

/* ── test / diagnostic surface ────────────────────────────────────────── */

/** The components above are the only production entries; pure logic is re-exported for tests. */
export * from './control-model.ts'
export { BOOP_CONTROL_CSS, CONTROL_STYLE_TAG, installControlStyles } from './control-styles.ts'

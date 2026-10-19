/**
 * BOOP source card (E04-01 batch 2, deliverable 3).
 *
 * Shows the REAL provenance BOOP's ledger holds: scope id, per-Session source
 * generation and the exact seq BOOP has read through, plus the honest state of
 * every source (full / behind / unseen / processing / gap / excluded / stale
 * generation). An unreadable plane is shown as unavailable — never as an empty
 * list (FE-11: 断线不是空任务列表).
 *
 * "查看原会话" navigates by the exact Session id through native navigation
 * (`ctx.uiWorkspace.openSession`), never by a guessed title, and the native
 * Conversation keeps the target Session's own drafts (FE-05).
 */
import React from 'react'

export type SourceCoverage = 'full' | 'behind' | 'unseen' | 'unverified' | 'processing' | 'gap' | 'excluded'

export interface SourceRowFacts {
  sessionId: string
  title: string | null
  sourceGeneration: string
  headSeq: number | null
  throughSeq: number | null
  state: 'fresh' | 'dirty' | 'processing' | 'gap' | 'excluded' | 'unseen'
  coverage: SourceCoverage
}

export interface SourcesFacts {
  schemaVersion: 1
  available: boolean
  reason: string | null
  detail: string | null
  scopeId: string | null
  discovered: number
  known: number
  staleGenerations: number
  sources: SourceRowFacts[]
}

export type SourceLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; facts: SourcesFacts }
  | { kind: 'error'; message: string }

const COVERAGE_TEXT: Readonly<Record<SourceCoverage, string>> = {
  full: '覆盖至该会话最近一轮',
  behind: '落后：还没读到最新一轮，操作前会再核查',
  unseen: '尚未读取（只有发现记录）',
  unverified: '已读至记录水位，本次未校验是否最新',
  processing: '读取中；中断后可续',
  gap: '存在缺口：未连续覆盖，证据缺失',
  excluded: '已排除：不再使用，原聊天仍保留',
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  'ledger-unavailable': 'BOOP 记忆账本不可用，来源覆盖无法读取。',
  'source-reader-unavailable': '只读会话查询平面不可用，来源无法列出。',
  'source-read-failed': '来源读取失败；这不是“没有来源”。',
}

export function sourceCoverageText(coverage: SourceCoverage): string {
  return COVERAGE_TEXT[coverage] ?? coverage
}

export function sourceUnavailableText(reason: string | null): string {
  if (reason === null) return '来源读取不可用。'
  return REASON_TEXT[reason] ?? `来源读取不可用（${reason}）。`
}

function shortId(value: string): string {
  if (value.length <= 18) return value
  return `${value.slice(0, 10)}…${value.slice(-6)}`
}

function seqLabel(throughSeq: number | null, headSeq: number | null): string {
  if (throughSeq === null || throughSeq < 0) {
    return headSeq === null ? '覆盖：未读' : `覆盖：未读 / 会话到 ${headSeq}`
  }
  if (headSeq === null) return `覆盖：已读至 ${throughSeq}（未校验最新）`
  return `覆盖：${throughSeq} / 会话到 ${headSeq}`
}

export interface BoopSourceCardProps {
  load: SourceLoad
  onRefresh?: () => void
  onOpenSession?: (sessionId: string) => void
  mainSessionId?: string | null
  refreshing?: boolean
}

export function BoopSourceCard({
  load,
  onRefresh,
  onOpenSession,
  mainSessionId,
  refreshing,
}: BoopSourceCardProps): React.ReactElement {
  const facts = load.kind === 'ready' ? load.facts : null
  const openSession = onOpenSession ?? (() => undefined)
  return (
    <section data-boop-source="" aria-label="BOOP 来源">
      <div className="boop-source-head">
        <h2>来源</h2>
        {load.kind === 'ready' && facts?.available ? (
          <ul className="boop-source-chips" aria-label="来源统计">
            <li className="boop-source-chip">已发现 {facts.discovered}</li>
            <li className="boop-source-chip">账本记录 {facts.known}</li>
            {facts.staleGenerations > 0 ? (
              <li className="boop-source-chip">过期世代 {facts.staleGenerations}</li>
            ) : null}
          </ul>
        ) : null}
        {onRefresh ? (
          <button
            type="button"
            className="boop-source-refresh"
            onClick={onRefresh}
            disabled={refreshing === true}
            aria-label="刷新来源覆盖"
          >
            {refreshing === true ? '刷新中…' : '刷新'}
          </button>
        ) : null}
      </div>

      {load.kind === 'loading' ? (
        <p className="boop-source-note" role="status">
          正在读取来源覆盖…
        </p>
      ) : null}

      {load.kind === 'error' ? (
        <p className="boop-source-note" data-tone="bad" role="alert">
          来源状态不可用：{load.message}。这里不会显示成“没有来源”。
        </p>
      ) : null}

      {facts && !facts.available ? (
        <p className="boop-source-note" data-tone="bad" role="alert">
          {sourceUnavailableText(facts.reason)}
          {facts.detail ? `（${facts.detail}）` : ''}
        </p>
      ) : null}

      {facts && facts.available ? (
        <>
          {facts.sources.length === 0 ? (
            <p className="boop-source-note" role="status">
              还没有可读取的会话来源。来源出现后，这里会显示真实的覆盖范围。
            </p>
          ) : (
            <ul className="boop-source-list">
              {facts.sources.map((source) => {
                const isMain = mainSessionId !== null && mainSessionId !== undefined && source.sessionId === mainSessionId
                return (
                  <li
                    className="boop-source-row"
                    key={`${source.sessionId}\u0000${source.sourceGeneration}`}
                    data-boop-source-row={source.coverage}
                    data-session-id={source.sessionId}
                  >
                    <div className="boop-source-row-top">
                      <span className="boop-source-title" title={source.title ?? source.sessionId}>
                        {source.title ?? '未命名会话'}
                        {isMain ? '（BOOP 主会话）' : ''}
                      </span>
                      <button
                        type="button"
                        className="boop-source-open"
                        onClick={() => openSession(source.sessionId)}
                        aria-label={`打开原会话 ${source.sessionId}`}
                      >
                        {isMain ? '打开主聊天' : '查看原会话'}
                      </button>
                    </div>
                    <div className="boop-source-meta">
                      <span className="boop-source-id" title={source.sessionId}>
                        {shortId(source.sessionId)}
                      </span>
                      <span className={`boop-source-coverage`} data-coverage={source.coverage}>
                        {sourceCoverageText(source.coverage)}
                      </span>
                      <span>{seqLabel(source.throughSeq, source.headSeq)}</span>
                      <span title={source.sourceGeneration}>世代 {shortId(source.sourceGeneration)}</span>
                      <span>状态 {source.state}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {facts.staleGenerations > 0 ? (
            <p className="boop-source-note" data-tone="warn">
              有 {facts.staleGenerations} 条旧来源世代仍在账本里：它们只作为证据引用保留，不会被当作当前覆盖。
            </p>
          ) : null}
        </>
      ) : null}

      <p className="boop-source-note">
        来源标签由宿主账本生成；模型不能伪造“已覆盖”状态。打开原会话只定位精确 Session，不按标题猜。
      </p>
    </section>
  )
}

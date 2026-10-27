/**
 * BOOP initialization card (E04-01 batch 2, deliverable 2).
 *
 * Where: the native Conversation's additive `conversation.input.dock` seat
 * (scope `session`, declared by client-ui-conversation; see the rc.2.1 Slot
 * catalog). It is a dock above the native composer — NOT a replacement of the
 * input root and NOT a full-screen onboarding (FE-03), and it renders ONLY for
 * the exact BOOP main Session, so ordinary Sessions stay byte-for-byte native
 * (FE-01).
 *
 * What the three E03-03 modes do here: the card collects the choice, then asks
 * `boop/initApply`. That call writes only when write mode and the writer lease
 * are both held. Otherwise it returns the real refusal (`executed: false`).
 * The card never shows a success the host did not report.
 */
import React from 'react'
import { BoopMark } from './brand.tsx'
import { isMainSession, type BoopCall, type MainSessionStore } from './main-session.ts'

export const INIT_CHOICES = [
  { mode: 'from_now', label: '从现在开始' },
  { mode: 'learn_history', label: '学习已有会话' },
  { mode: 'import_memory', label: '导入记忆' },
] as const

export type InitChoiceMode = (typeof INIT_CHOICES)[number]['mode']

/** Mirror of the host `InitPlanFacts` (client half keeps no authority). */
export interface InitPlanFacts {
  schemaVersion: 1
  mode: InitChoiceMode | string
  label?: string
  state: 'available' | 'unavailable'
  executed: boolean
  reason: string
  copy: string
  writeModeEnabled: boolean
  gates: Record<string, string>
  storage: { ok: boolean; path: string; scopeId: string; writable: boolean } | null
  sources: { discovered: number; known: number; fresh: number; dirty: number; gap: number; excluded: number } | null
  processed: number
  total: number | null
}

type InitStatus =
  | { kind: 'choice' }
  | { kind: 'pending'; mode: InitChoiceMode }
  | { kind: 'result'; mode: InitChoiceMode; facts: InitPlanFacts }
  | { kind: 'error'; mode: InitChoiceMode; message: string }

const REASON_COPY: Readonly<Record<string, string>> = {
  'ledger-unavailable': 'BOOP 记忆账本当前不可用，初始化不能开始；没有写入任何数据。',
  'read-only-ledger': '另一个 BOOP 进程正在管理数据域；本次只能只读，不会写入任何数据。',
  'write-mode-disabled': '写模式在 G01–G06 与 G08、G09 通过前保持关闭；本次初始化不会写入任何数据。',
  'import-pipeline-unavailable': '导入校验/预览流水线尚未接通；本次不会读取任何文件。',
  'init-jobs-not-wired': '后台初始化作业尚未接线；本次没有设置读取水位。',
}

function reasonCopy(facts: InitPlanFacts): string {
  return REASON_COPY[facts.reason] ?? `初始化尚未接通（${facts.reason}）。`
}

function storageText(facts: InitPlanFacts): string {
  if (!facts.storage) return '账本：不可用'
  if (!facts.storage.ok) return '账本：只读（单写者未就位）'
  return facts.storage.writable ? '账本：在位（单写者）' : '账本：只读'
}

function gateText(facts: InitPlanFacts): string {
  const g05 = facts.gates?.G05
  const g06 = facts.gates?.G06
  if (g05 === undefined && g06 === undefined) return '门禁：本部署未报告'
  return `门禁：G05 ${g05 ?? 'NOT_RUN'} · G06 ${g06 ?? 'NOT_RUN'}`
}

export interface BoopInitDockProps {
  /** Standard session-scoped slot prop: the Session this dock is rendered in. */
  sessionId?: string
  /** Observable BOOP main-Session identity store (injected by the plugin). */
  observer?: MainSessionStore
  call?: BoopCall
  onOpenBoard?: () => void
}

function useMainSessionId(observer: MainSessionStore | undefined): string | null {
  return React.useSyncExternalStore(
    React.useCallback(
      (listener: () => void) => (observer ? observer.subscribe(listener) : () => undefined),
      [observer],
    ),
    React.useCallback(() => observer?.getSnapshot().mainSessionId ?? null, [observer]),
    React.useCallback(() => null, []),
  )
}

export function BoopInitDock({ sessionId, observer, call, onOpenBoard }: BoopInitDockProps): React.ReactElement | null {
  const mainSessionId = useMainSessionId(observer)
  const [status, setStatus] = React.useState<InitStatus>({ kind: 'choice' })
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Zero pollution: an ordinary Session gets no BOOP card at all (FE-01).
  if (!isMainSession(mainSessionId, sessionId)) return null

  const submit = (mode: InitChoiceMode): void => {
    if (typeof call !== 'function') {
      setStatus({ kind: 'error', mode, message: '宿主调用通道不可用。' })
      return
    }
    setStatus({ kind: 'pending', mode })
    void call('boop/initApply', { mode }).then(
      (result) => {
        if (!mounted.current) return
        if (result?.ok && result.value && typeof (result.value as InitPlanFacts).reason === 'string') {
          setStatus({ kind: 'result', mode, facts: result.value as InitPlanFacts })
          return
        }
        setStatus({
          kind: 'error',
          mode,
          message: result?.error?.message ?? '宿主没有返回初始化状态。',
        })
      },
      (error: unknown) => {
        if (!mounted.current) return
        setStatus({ kind: 'error', mode, message: error instanceof Error ? error.message : String(error) })
      },
    )
  }

  const pending = status.kind === 'pending'
  const pendingMode = status.kind === 'pending' ? status.mode : null

  return (
    <section data-boop-dock="init" role="group" aria-label="BOOP 初始化">
      <div className="boop-dock-head">
        <BoopMark size={20} />
        <span>BOOP · 波波</span>
      </div>
      <p className="boop-dock-prompt">
        我会在这里帮你管理 DSH 项目。先选一种记忆起点：从现在开始、学习已有会话，或导入你的记忆。
      </p>

      {status.kind === 'choice' || status.kind === 'pending' ? (
        <div className="boop-dock-choices">
          {INIT_CHOICES.map((choice) => (
            <button
              key={choice.mode}
              type="button"
              className="boop-dock-choice"
              data-boop-init-mode={choice.mode}
              disabled={pending}
              aria-busy={pendingMode === choice.mode}
              onClick={() => submit(choice.mode)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}

      {status.kind === 'pending' ? (
        <p className="boop-dock-hint" role="status">
          正在查询初始化状态…
        </p>
      ) : null}

      {status.kind === 'result' ? (
        <div className="boop-dock-result" role="status" data-boop-init-state={status.facts.state}>
          <p className="boop-dock-copy">{status.facts.copy || reasonCopy(status.facts)}</p>
          <ul className="boop-dock-evidence">
            <li>{storageText(status.facts)}</li>
            <li>写模式：{status.facts.writeModeEnabled ? '开启' : '关闭'}</li>
            <li>{gateText(status.facts)}</li>
            {status.facts.sources ? <li>已发现会话：{status.facts.sources.discovered}</li> : null}
            <li>
              {status.facts.executed
                ? `已执行：是（${status.facts.processed} 处写入）`
                : '已执行：否（0 写入）'}
            </li>
          </ul>
          <p className="boop-dock-reason">reason: {status.facts.reason}</p>
          <div className="boop-dock-actions">
            <button type="button" className="boop-dock-choice" data-variant="secondary" onClick={() => setStatus({ kind: 'choice' })}>
              重新选择
            </button>
            <button type="button" className="boop-dock-choice" data-variant="secondary" onClick={() => submit(status.mode)}>
              重试
            </button>
            {onOpenBoard ? (
              <button type="button" className="boop-dock-choice" data-variant="secondary" onClick={onOpenBoard}>
                查看任务板
              </button>
            ) : null}
          </div>
          <p className="boop-dock-hint">这条卡片不会自动发送消息；原生输入框仍归 DSH 所有。</p>
        </div>
      ) : null}

      {status.kind === 'error' ? (
        <div className="boop-dock-result" role="alert">
          <p className="boop-dock-error">初始化状态不可用：{status.message}</p>
          <div className="boop-dock-actions">
            <button type="button" className="boop-dock-choice" data-variant="secondary" onClick={() => submit(status.mode)}>
              重试
            </button>
            <button type="button" className="boop-dock-choice" data-variant="secondary" onClick={() => setStatus({ kind: 'choice' })}>
              返回选择
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

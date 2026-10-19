/**
 * BOOP row in the native Settings → General section (E04-01 batch 2).
 *
 * Design constraint (04§02): BOOP adds ONE additive settings row; General,
 * Models, Plugins and the other native pages are never replaced. The row is a
 * read-mostly status + navigation row: it shows the real main-Session identity,
 * data-domain/ledger facts and the native-integration posture, and offers the
 * same native navigation as the fixed entry. It writes no host setting and never
 * pretends a toggle exists.
 */
import React from 'react'
import { BoopMark } from './brand.tsx'
import { mainSessionReasonText, mainSessionStatusLine, type BoopCall, type MainSessionStore } from './main-session.ts'
import { useMainSessionState } from './header.tsx'

interface BootstrapFacts {
  scope: { dshProfileVersion: string; writeModeEnabled: boolean }
  storage: { ok: boolean; path: string; scopeId: string } | null
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; facts: BootstrapFacts }
  | { kind: 'error'; message: string }

export interface BoopSettingsRowProps {
  observer?: MainSessionStore
  call?: BoopCall
  onOpenMain?: () => void
  onOpenBoard?: () => void
}

export function BoopSettingsRow({ observer, call, onOpenMain, onOpenBoard }: BoopSettingsRowProps): React.ReactElement {
  const state = useMainSessionState(observer)
  const [load, setLoad] = React.useState<LoadState>({ kind: 'loading' })

  React.useEffect(() => {
    let disposed = false
    setLoad({ kind: 'loading' })
    if (typeof call !== 'function') {
      setLoad({ kind: 'error', message: '宿主调用通道不可用' })
      return () => {
        disposed = true
      }
    }
    call('boop/bootstrap').then(
      (result) => {
        if (disposed) return
        if (result?.ok && result.value) setLoad({ kind: 'ready', facts: result.value as BootstrapFacts })
        else setLoad({ kind: 'error', message: result?.error?.message ?? '宿主没有返回 BOOP 状态' })
      },
      (error: unknown) => {
        if (disposed) return
        setLoad({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      disposed = true
    }
  }, [call])

  const status = state === null ? null : mainSessionStatusLine(state)
  const reason = mainSessionReasonText(state?.host?.reason ?? state?.error ?? null)
  const facts = load.kind === 'ready' ? load.facts : null

  return (
    <section data-boop-settings="" aria-label="BOOP 设置">
      <div className="boop-settings-head">
        <BoopMark size={20} />
        <h2>BOOP · 波波</h2>
        {status ? <span className="boop-settings-status" data-tone={status.tone}>{status.text}</span> : null}
      </div>
      <p className="boop-settings-line">BOOP 的对话就是原生 Conversation：不接管输入、队列或快捷键，也没有独立主题开关。</p>
      <div className="boop-settings-facts">
        <div className="boop-settings-row"><span>主会话</span><span>{state?.mainSessionId ?? '尚未解析'}</span></div>
        <div className="boop-settings-row">
          <span>身份</span>
          <span>{state?.host?.state === 'bound' && state.host.durable ? '已绑定（账本）' : '未持久绑定'}</span>
        </div>
        <div className="boop-settings-row"><span>数据域</span><span>{state?.host?.scopeId ?? '不可用'}</span></div>
        {facts ? (
          <>
            <div className="boop-settings-row"><span>写模式</span><span>{facts.scope.writeModeEnabled ? '开启' : '关闭（G01–G06 通过前）'}</span></div>
            <div className="boop-settings-row">
              <span>账本</span>
              <span>{facts.storage ? (facts.storage.ok ? '在位（单写者）' : '只读') : '不可用'}</span>
            </div>
          </>
        ) : null}
        <div className="boop-settings-row"><span>主题 / 动效</span><span>跟随宿主；遵循系统减少动画偏好</span></div>
      </div>
      {load.kind === 'error' ? (
        <p className="boop-settings-line" data-tone="bad" role="alert">
          设置事实不可用：{load.message}。这里不会伪造开关状态。
        </p>
      ) : null}
      {reason !== null ? (
        <p className="boop-settings-line" data-tone="warn" role="status">
          {reason}
        </p>
      ) : null}
      <div className="boop-settings-actions">
        {onOpenMain ? (
          <button type="button" className="boop-settings-action" onClick={onOpenMain}>
            回到主聊天
          </button>
        ) : null}
        {onOpenBoard ? (
          <button type="button" className="boop-settings-action" onClick={onOpenBoard}>
            打开任务板
          </button>
        ) : null}
      </div>
    </section>
  )
}

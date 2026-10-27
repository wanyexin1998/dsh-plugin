import React from 'react'
import type { HomeView } from '../../shared/mvp-contract.ts'

export function SettingsPanel(props: {
  home: HomeView | null
  onClose: () => void
  onAdvanced: () => void
}): React.ReactElement {
  const closeRef = React.useRef<HTMLButtonElement>(null)
  const [diag, setDiag] = React.useState(false)
  React.useEffect(() => {
    closeRef.current?.focus()
  }, [])
  const ready = props.home?.state === 'ready' ? props.home : null
  return (
    <aside className="boop-drawer" aria-label="设置">
      <div className="boop-card-title">
        <h2>设置</h2>
        <button ref={closeRef} type="button" className="boop-text-button" onClick={props.onClose}>关闭</button>
      </div>
      <section>
        <h3>模型</h3>
        <p className="boop-muted">在 DSH 的设置里连接模型，然后回到这里。波波不会改你的全局默认模型。</p>
        <button type="button" className="boop-text-button" onClick={props.onAdvanced}>展开本页的模型选择</button>
      </section>
      <section>
        <h3>可访问的工作</h3>
        <p className="boop-muted">
          {ready?.capabilities.readSources
            ? '当前沿用宿主已经允许、且没有被排除的范围。'
            : '还不能确认可以读取哪些工作。普通聊天仍然可用。'}
        </p>
      </section>
      <HistoryList />
      <button type="button" className="boop-text-button" aria-expanded={diag} onClick={() => setDiag((value) => !value)}>诊断</button>
      {diag ? <Diagnostics home={props.home} /> : null}
    </aside>
  )
}

export function HistoryList(): React.ReactElement {
  return (
    <section>
      <h3>历史</h3>
      <p className="boop-muted">以前的主聊天还在原来的会话里。这里不重新整理全部历史，也不会要求你先做三选一。</p>
    </section>
  )
}

export function Diagnostics(props: { home: HomeView | null }): React.ReactElement {
  const text = props.home
    ? `state=${props.home.state}; reason=${'reasonCode' in props.home ? props.home.reasonCode : 'none'}`
    : 'no-home'
  return (
    <div className="boop-card">
      <p className="boop-muted">复制前已去掉路径和密钥。这些信息只在诊断里出现。</p>
      <button
        type="button"
        className="boop-text-button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).catch(() => undefined)
        }}
      >
        复制诊断信息
      </button>
    </div>
  )
}

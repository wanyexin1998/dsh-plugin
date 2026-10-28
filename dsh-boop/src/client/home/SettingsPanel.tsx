import React from 'react'
import type { AccessView, HomeView } from '../../shared/mvp-contract.ts'

export function SettingsPanel(props: {
  home: HomeView | null
  access: AccessView | null
  onClose: () => void
  onAdvanced: () => void
  onSave: (mode: AccessView['mode'], workspaceIds: string[], sessionIds: string[]) => void
}): React.ReactElement {
  const closeRef = React.useRef<HTMLButtonElement>(null)
  const [diag, setDiag] = React.useState(false)
  React.useEffect(() => {
    closeRef.current?.focus()
  }, [])
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
        <AccessEditor access={props.access} onSave={props.onSave} />
      </section>
      <HistoryList />
      <button type="button" className="boop-text-button" aria-expanded={diag} onClick={() => setDiag((value) => !value)}>诊断</button>
      {diag ? <Diagnostics home={props.home} /> : null}
    </aside>
  )
}

export function AccessEditor(props: {
  access: AccessView | null
  onSave: (mode: AccessView['mode'], workspaceIds: string[], sessionIds: string[]) => void
}): React.ReactElement {
  const [mode, setMode] = React.useState<AccessView['mode']>(props.access?.mode ?? 'all_authorized')
  const [workspaces, setWorkspaces] = React.useState((props.access?.workspaceIds ?? []).join(', '))
  const [sessions, setSessions] = React.useState((props.access?.sessionIds ?? []).join(', '))
  React.useEffect(() => {
    if (!props.access) return
    setMode(props.access.mode)
    setWorkspaces(props.access.workspaceIds.join(', '))
    setSessions(props.access.sessionIds.join(', '))
  }, [props.access])
  const split = (value: string) => value.split(/[,，\s]+/u).map((item) => item.trim()).filter((item) => item.length > 0)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        props.onSave(mode, mode === 'selected' ? split(workspaces) : [], mode === 'selected' ? split(sessions) : [])
      }}
    >
      <p className="boop-muted">{props.access ? `当前范围版本 ${props.access.policyEpoch}。被排除或忘记的来源仍然不会读取。` : '还不能确认可以读取哪些工作。普通聊天仍然可用。'}</p>
      <label className="boop-muted">范围
        <select value={mode} onChange={(event) => setMode(event.target.value as AccessView['mode'])}>
          <option value="all_authorized">沿用宿主已经允许的范围</option>
          <option value="selected">只看我列出的工作区或会话</option>
          <option value="none">先不读取工作</option>
        </select>
      </label>
      {mode === 'selected' ? (
        <>
          <label className="boop-muted">工作区
            <input value={workspaces} onChange={(event) => setWorkspaces(event.target.value)} />
          </label>
          <label className="boop-muted">会话
            <input value={sessions} onChange={(event) => setSessions(event.target.value)} />
          </label>
        </>
      ) : null}
      <button type="submit" className="boop-text-button">保存范围</button>
    </form>
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

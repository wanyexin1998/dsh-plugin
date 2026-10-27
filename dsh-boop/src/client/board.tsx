/**
 * BOOP board panel.
 *
 * Layout: the interactive BOOP companion leads the panel — the user always
 * sees the same whale they talk to in chat. Every line of state it shows maps
 * to a real host fact from boop/bootstrap, boop/mainSession and boop/sources:
 * connection, ledger, main-Session identity, recovery gate, capabilities and the
 * real per-Source coverage. No invented cheer, no fake busy, no fake empty list.
 *
 * The four-column task projection (待开始/进行中/待我处理/已结束) is provided by
 * E04-02's `TaskboardPanel` (selective extraction from dashi-taskboard, wired
 * to the read-only `boopTasks` Host projection); it never invents task state
 * and never turns an unreadable plane into an empty list.
 *
 * The human-control area below it is E04-03's `BoopControlPanel`: approval
 * decisions that only record a ledger decision (never dispatch), a deterministic
 * scoped Stop with per-item/unknown results, and explicit restart-recovery
 * release — all with server-reported refusal reasons and audit receipts.
 */
import React from 'react'
import { BoopCompanion, type CompanionState } from './companion.tsx'
import { BoopCompanion3D } from './companion3d.tsx'
import { BoopSourceCard, type SourceLoad, type SourcesFacts } from './source.tsx'
import { TaskboardPanel } from './taskboard/index.tsx'
import { BoopControlPanel } from './control.tsx'
import { writeModeClosed } from './write-mode-copy.ts'
import type { MainSessionHostFacts } from './main-session.ts'
// Re-exported for the client test bundle (state mapping + fallback behaviour).
export { BoopCompanion3D }

export interface BoopBootstrap {
  schemaVersion: 1
  product: 'BOOP'
  scope: {
    dshProfileVersion: string
    dshCommit: string
    writeModeEnabled: boolean
    recoveryGateArmed: boolean
  }
  capabilities: Record<string, boolean>
  gates: Record<string, 'NOT_RUN' | 'PASS' | 'BLOCKED'>
  writeMode?: { blockedByGates?: string[] }
  services: string[]
  storage?: {
    ok: boolean
    path: string
    schemaVersion: number | null
    lease: { held: boolean }
    scope: { scopeId: string }
  } | null
}

export type BoopCall = (
  endpoint: string,
  args?: Record<string, unknown>,
) => Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }>

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: BoopBootstrap }
  | { kind: 'offline' }
  | { kind: 'error'; message: string }

/**
 * The 3D player exposes exactly five states (its own spec). Map BOOP's
 * companion state onto them without inventing a sixth:
 *  - offline / blocked → `error` (the player keeps `error` until the business
 *    state clears it, which is exactly the frozen rule);
 *  - delivered → `success` (plays once, then the player returns to idle);
 *  - thinking / working → `think`;
 *  - otherwise → idle.
 */
export function to3DState(state: CompanionState): 'idle' | 'listen' | 'think' | 'success' | 'error' {
  switch (state) {
    case 'attention':
      return 'listen'
    case 'thinking':
    case 'working':
      return 'think'
    case 'delivered':
      return 'success'
    case 'offline':
      return 'error'
    case 'listening':
      return 'listen'
    default:
      return 'idle'
  }
}

/** Map host facts to the companion's state — evidence first, never theatre. */
export function companionState(load: LoadState): CompanionState {
  if (load.kind === 'loading') return 'idle'
  if (load.kind === 'offline' || load.kind === 'error') return 'offline'
  const blocked = Object.values(load.data.gates).some((g) => g === 'BLOCKED')
  if (blocked) return 'attention'
  return 'idle'
}

export function companionLine(load: LoadState): string {
  if (load.kind === 'loading') return '正在连接宿主…'
  if (load.kind === 'offline') return '连接已断开。恢复后我会把任务看板重新接上。'
  if (load.kind === 'error') return `BOOP 面板出错：${load.message}`
  const data = load.data
  const storage = data.storage
  if (!storage) return '记忆账本不可用，我只能保持只读。'
  if (!storage.ok) return '另一个 BOOP 进程在管理数据域；我保持只读。'
  if (companionState(load) === 'attention') return '有些门禁被阻断，需要你处理。'
  return '我是 BOOP（波波）。这里是我的数据域、能力和你还没解锁的门。'
}

type MainSessionLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; facts: MainSessionHostFacts }
  | { kind: 'error'; message: string }

function identityLabel(facts: MainSessionHostFacts): string {
  if (facts.state === 'bound' && facts.durable) return '已绑定（账本）'
  return '未持久绑定（降级）'
}

function mainReasonText(facts: MainSessionHostFacts | null): string | null {
  switch (facts?.reason ?? null) {
    case null:
      return null
    case 'ledger-unavailable':
      return '记忆账本不可用：主聊天仍可用，但主会话身份没有持久绑定。'
    case 'read-only-ledger':
      return '另一个 BOOP 进程正在管理数据域：身份只能只读使用。'
    case 'bind-failed':
      return '主会话身份写入失败；重试后仍会定位同一个会话。'
    case 'ledger-read-failed':
      return '账本身份读取失败；没有当作成功处理。'
    default:
      return facts?.reason ?? null
  }
}

export function BoopBoard({
  call,
  onOpenSession,
  onOpenMain,
}: {
  call: BoopCall
  onOpenSession?: (sessionId: string) => void
  onOpenMain?: () => void
}): React.ReactElement {
  const [state, setState] = React.useState<LoadState>({ kind: 'loading' })
  const [sources, setSources] = React.useState<SourceLoad>({ kind: 'loading' })
  const [sourcesRefreshing, setSourcesRefreshing] = React.useState(false)
  const [main, setMain] = React.useState<MainSessionLoad>({ kind: 'loading' })

  const loadSources = React.useCallback((): void => {
    setSourcesRefreshing(true)
    call('boop/sources')
      .then((result) => {
        if (result.ok && result.value) setSources({ kind: 'ready', facts: result.value as SourcesFacts })
        else setSources({ kind: 'error', message: result.error?.message ?? '宿主没有返回来源状态' })
      })
      .catch((error: unknown) => {
        setSources({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => setSourcesRefreshing(false))
  }, [call])

  const loadMain = React.useCallback((): void => {
    setMain({ kind: 'loading' })
    call('boop/mainSession')
      .then((result) => {
        if (result.ok && result.value) setMain({ kind: 'ready', facts: result.value as MainSessionHostFacts })
        else setMain({ kind: 'error', message: result.error?.message ?? '宿主没有返回主会话身份' })
      })
      .catch((error: unknown) => {
        setMain({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
  }, [call])

  React.useEffect(() => {
    let disposed = false
    call('boop/bootstrap')
      .then((result) => {
        if (disposed) return
        if (result.ok && result.value) setState({ kind: 'ready', data: result.value as BoopBootstrap })
        else setState({ kind: 'offline' })
      })
      .catch((error: unknown) => {
        if (disposed) return
        setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      disposed = true
    }
  }, [call])

  React.useEffect(() => {
    loadSources()
    loadMain()
  }, [loadSources, loadMain])

  const data = state.kind === 'ready' ? state.data : null
  const mainFacts = main.kind === 'ready' ? main.facts : null

  return (
    <div data-boop-panel="">
      <header className="boop-hero">
        <BoopCompanion3D
          state={to3DState(companionState(state))}
          line={companionLine(state)}
          size={168}
        />
        <div className="boop-hero-text">
          <h1>BOOP · 波波</h1>
          <p>你的 AI 项目助理</p>
          {data && (
            <div className="boop-chips">
              <span className={data.scope.recoveryGateArmed ? 'boop-chip ok' : 'boop-chip'}>恢复门禁已装备</span>
              <span className={data.scope.writeModeEnabled ? 'boop-chip warn' : 'boop-chip'}>
                写模式{data.scope.writeModeEnabled ? '开启' : '关闭'}
              </span>
              {data.storage && (
                <span className={data.storage.ok ? 'boop-chip ok' : 'boop-chip warn'}>
                  {data.storage.ok ? '账本在位（单写者）' : '只读模式'}
                </span>
              )}
            </div>
          )}
        </div>
      </header>

      {state.kind === 'loading' && <div className="boop-card">正在连接 Host…</div>}
      {state.kind === 'offline' && <div className="boop-card">连接已断开。任务看板会在重新连接后刷新，不会显示伪空列表。</div>}
      {state.kind === 'error' && <div className="boop-card">面板出错：{state.message}</div>}

      {/* 项目 / 主会话 */}
      <section className="boop-card">
        <h2>BOOP 主会话（原生 Conversation）</h2>
        {main.kind === 'loading' && <p className="boop-muted">正在确认主会话身份…</p>}
        {main.kind === 'error' && (
          <p className="boop-muted" role="alert">
            主会话身份不可用：{main.message}。没有把失败当作成功。
          </p>
        )}
        {mainFacts && (
          <div className="boop-facts">
            <div className="boop-row">
              <span>会话</span>
              <span>{mainFacts.mainSessionId}（点击“回到主聊天”由原生导航打开）</span>
            </div>
            <div className="boop-row">
              <span>身份</span>
              <span>{identityLabel(mainFacts)}</span>
            </div>
            <div className="boop-row">
              <span>数据域</span>
              <span>{mainFacts.scopeId ?? '不可用'}</span>
            </div>
            {mainFacts.storage && (
              <div className="boop-row">
                <span>账本</span>
                <span>{mainFacts.storage.path.split(/[\\/]/).slice(-3).join('/') || '不可用'}</span>
              </div>
            )}
            {mainReasonText(mainFacts) && (
              <p className="boop-muted" role="status">
                {mainReasonText(mainFacts)}
              </p>
            )}
            <div className="boop-actions">
              {onOpenMain && (
                <button type="button" className="boop-action" data-variant="primary" onClick={onOpenMain}>
                  回到主聊天
                </button>
              )}
              <button type="button" className="boop-action" onClick={loadMain}>
                刷新身份
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 来源 */}
      <BoopSourceCard
        load={sources}
        refreshing={sourcesRefreshing}
        onRefresh={loadSources}
        onOpenSession={onOpenSession}
        mainSessionId={mainFacts?.mainSessionId ?? null}
      />

      {/* 任务看板：E04-02 接通的只读四组投影；不可读/断线/旧响应都如实显示 */}
      <TaskboardPanel call={call} onOpenSession={onOpenSession} />

      {/* 人工控制：E04-03 的审批决定 / 确定性 Stop / 重启恢复显式释放 */}
      <BoopControlPanel call={call} onOpenSession={onOpenSession} />

      {/* 设置：只读事实，不写宿主设置 */}
      <section className="boop-card">
        <h2>设置（只读）</h2>
        <div className="boop-facts">
          <div className="boop-row"><span>主题</span><span>跟随宿主浅/深主题（BOOP 没有独立主题开关）</span></div>
          <div className="boop-row"><span>动效</span><span>遵循系统“减少动画”偏好</span></div>
          <div className="boop-row"><span>样式作用域</span><span>BOOP 自有 data-plugin-css，停用插件即移除</span></div>
          <div className="boop-row"><span>输入与队列</span><span>原生 Composer / 队列；BOOP 不接管输入根，不改普通 Session 配置</span></div>
          <div className="boop-row"><span>写模式</span><span>{data ? (data.scope.writeModeEnabled ? '开启' : writeModeClosed(data.writeMode?.blockedByGates)) : '未知'}</span></div>
        </div>
      </section>

      {data && (
        <>
          <section className="boop-card">
            <h2>数据域</h2>
            <div className="boop-row"><span>宿主版本</span><span>DSH {data.scope.dshProfileVersion}</span></div>
            <div className="boop-row"><span>固定提交</span><span>{data.scope.dshCommit.slice(0, 12)}…</span></div>
            {data.storage && (
              <>
                <div className="boop-row"><span>账本</span><span>{data.storage.path.split(/[\\/]/).slice(-3).join('/')}</span></div>
                <div className="boop-row"><span>schema</span><span>v{data.storage.schemaVersion ?? '?'}</span></div>
                <div className="boop-row"><span>数据域</span><span>{data.storage.scope.scopeId}</span></div>
              </>
            )}
          </section>

          <section className="boop-card">
            <h2>验证门（G01–G09）</h2>
            <div className="boop-gates">
              {Object.entries(data.gates).map(([gate, status]) => (
                <span key={gate} className={`boop-gate ${status === 'PASS' ? 'ok' : status === 'BLOCKED' ? 'bad' : ''}`}>
                  {gate} · {status}
                </span>
              ))}
            </div>
            <p className="boop-muted">写模式在所有门通过前保持关闭；这是安全姿态，不是待办。</p>
          </section>

          <section className="boop-card">
            <h2>宿主能力（rc.2 实测矩阵）</h2>
            <div className="boop-gates">
              {Object.entries(data.capabilities).map(([name, present]) => (
                <span key={name} className={`boop-gate ${present ? 'ok' : ''}`}>
                  {name} · {present ? 'available' : 'absent'}
                </span>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

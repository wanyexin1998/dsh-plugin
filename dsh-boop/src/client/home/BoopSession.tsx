import React from 'react'
import { BoopWelcome } from './Welcome.tsx'
import { ComposerState } from './ComposerState.tsx'
import { TargetCandidates } from './TargetCandidates.tsx'
import { WorkCard } from './WorkCard.tsx'
import type { HomeController, HomeSnapshot } from './controller.ts'

export interface BoopSessionProps {
  renderFactorySlot?: (name: string, input: Record<string, unknown>, options: { slots: { views: React.ComponentType<any> }; fallback: React.ReactElement }) => React.ReactElement
  renderSlot?: (name: string, input?: Record<string, unknown>) => React.ReactElement
  useSession?: (selector: (state: { openState?: string; blank?: boolean }) => unknown) => unknown
  useChat?: (selector: (state: { legacy?: { nodes?: unknown[] } }) => unknown) => unknown
  useComposerBlock?: () => { blocked?: boolean } | null
  useInput?: (selector: (state: { phase?: string }) => unknown) => unknown
}

const SessionUi = React.createContext<{ controller: HomeController; snapshot: HomeSnapshot } | null>(null)

export function HomeUiProvider(props: { controller: HomeController; snapshot: HomeSnapshot; children: React.ReactNode }): React.ReactElement {
  return <SessionUi.Provider value={{ controller: props.controller, snapshot: props.snapshot }}>{props.children}</SessionUi.Provider>
}

export function BoopSession(props: BoopSessionProps): React.ReactElement {
  const openState = typeof props.useSession === 'function' ? props.useSession((state) => state.openState) : 'ready'
  const phase = openState === 'loading' || openState === 'settling' ? 'settling' : 'active'
  if (typeof props.renderFactorySlot !== 'function') return <BoopUnavailable />
  return props.renderFactorySlot('conversation.content', {
    variant: 'embedded',
    phase,
    hero: false,
  }, {
    slots: { views: BoopConversationViews },
    fallback: <BoopUnavailable />,
  })
}

export function BoopConversationViews(props: BoopSessionProps): React.ReactElement {
  const ui = React.useContext(SessionUi)
  const blank = typeof props.useSession === 'function' ? props.useSession((state) => state.blank) !== false : true
  const nodes = typeof props.useChat === 'function' ? props.useChat((state) => state.legacy?.nodes) : []
  const inputPhase = typeof props.useInput === 'function' ? String(props.useInput((state) => state.phase) ?? 'plain') : 'plain'
  const modelMissing = ui?.snapshot.home?.state === 'ready' && ui.snapshot.home.capabilities.send === false
  const [inserted, setInserted] = React.useState<string | null>(null)
  return (
    <>
      {blank && ui ? (
        <BoopWelcome
          message={ui.snapshot.message}
          modelMissing={Boolean(modelMissing)}
          onSetup={() => ui.controller.setDrawer('settings', true)}
        />
      ) : null}
      {typeof props.renderSlot === 'function' ? props.renderSlot('conversation.session', { view: 'chat' }) : null}
      <TargetCandidates
        nodes={nodes}
        phase={inputPhase}
        inserted={inserted}
        onInsert={async (candidate) => {
          if (!ui) return false
          const applied = await ui.controller.insertCandidate(candidate.mention, candidate.title)
          if (applied) setInserted(candidate.selectionKey)
          return applied
        }}
      />
      {ui && ui.snapshot.summary.length > 0 ? (
        <div className="boop-summary">
          {ui.snapshot.summary.map((task) => (
            <WorkCard key={task.taskId} task={task} onAction={(action, item) => { void runAction(ui.controller, action, item) }} />
          ))}
        </div>
      ) : null}
      {ui ? (
        <ComposerState
          connection={ui.snapshot.connection}
          modelMissing={Boolean(modelMissing) && ui.snapshot.advanced && !blank}
          notice={ui.snapshot.notice}
          onRetry={() => ui.controller.reconnect()}
          onSetup={() => ui.controller.setDrawer('settings', true)}
        />
      ) : null}
    </>
  )
}

export function BoopUnavailable(): React.ReactElement {
  return <div className="boop-banner" role="status">波波的聊天暂时不能嵌进来。你可以回到普通 DSH，稍后再试。</div>
}

async function runAction(controller: HomeController, action: string, task: Parameters<HomeController['stopTask']>[0]): Promise<void> {
  if (action === 'view') controller.selectTask(task.taskId)
  else if (action === 'open_session') controller.openSource(task.target.sessionId)
  else if (action === 'stop') await controller.stopTask(task)
  else if (action === 'confirm') await controller.confirmTask(task)
  else if (action === 'continue') await controller.continueTask(task)
  else if (action === 'reconcile') await controller.reconcileTask(task)
  else controller.setDrawer('work')
}

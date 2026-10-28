import React from 'react'
import { BoopHeader } from './Header.tsx'
import { BoopSession, BoopUnavailable, HomeUiProvider } from './BoopSession.tsx'
import { HomeController, type HomeSnapshot } from './controller.ts'
import { SettingsPanel } from './SettingsPanel.tsx'
import { WorkDrawer } from './WorkDrawer.tsx'
import type { TaskView } from '../../shared/mvp-contract.ts'

export function useHomeSnapshot(controller: HomeController): HomeSnapshot {
  return React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

export function BoopHome(props: {
  controller: HomeController
  SessionProvider?: React.ComponentType<{ session: unknown; empty: () => React.ReactElement; children?: React.ReactNode }>
  renderSlot?: (name: string, input?: Record<string, unknown>) => React.ReactElement
}): React.ReactElement {
  const snapshot = useHomeSnapshot(props.controller)
  const workButton = React.useRef<HTMLButtonElement>(null)
  const closeDrawer = React.useCallback(() => {
    props.controller.setDrawer('closed')
    workButton.current?.focus()
  }, [props.controller])
  React.useEffect(() => {
    if (snapshot.drawer === 'closed') return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      const drawer = document.querySelector('[data-boop-home] .boop-drawer')
      const narrow = window.matchMedia('(max-width: 640px)').matches
      const inside = drawer?.contains(event.target as Node) === true
      if (!inside && !narrow) return
      event.preventDefault()
      closeDrawer()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [snapshot.drawer, closeDrawer])
  const onAction = (action: TaskView['availableActions'][number], task: TaskView): void => {
    if (action === 'view') props.controller.selectTask(task.taskId)
    else if (action === 'open_session') props.controller.openSource(task.target.sessionId)
    else if (action === 'stop') void props.controller.stopTask(task)
    else if (action === 'confirm') void props.controller.confirmTask(task)
    else if (action === 'continue') void props.controller.continueTask(task)
    else if (action === 'reconcile') void props.controller.reconcileTask(task)
    else props.controller.setDrawer('work')
  }
  const session = snapshot.phase === 'ready' && snapshot.reference?.native && props.SessionProvider && props.renderSlot
    ? (
      <props.SessionProvider key={snapshot.bindingVersion ?? 'home'} session={snapshot.reference.native} empty={() => <div className="boop-banner">正在准备你的波波…</div>}>
        {props.renderSlot('boop.session', {})}
      </props.SessionProvider>
    )
    : snapshot.phase === 'loading'
      ? <div className="boop-banner" role="status">正在准备你的波波…</div>
      : <div className="boop-banner" role="status">{snapshot.message}</div>
  return (
    <HomeUiProvider controller={props.controller} snapshot={snapshot}>
      <section
        data-boop-home=""
        data-boop-advanced={snapshot.advanced ? 'true' : 'false'}
        data-boop-connection={snapshot.connection}
        aria-label="BOOP · 波波"
      >
        <BoopHeader
          status={snapshot.phase === 'ready' ? '可以聊天，也可以继续已有项目' : snapshot.message}
          workOpen={snapshot.drawer === 'work'}
          settingsOpen={snapshot.drawer === 'settings'}
          workButtonRef={workButton}
          onWork={() => props.controller.setDrawer(snapshot.drawer === 'work' ? 'closed' : 'work')}
          onSettings={() => props.controller.setDrawer(snapshot.drawer === 'settings' ? 'closed' : 'settings')}
        />
        <div className="boop-body">
          <div className="boop-chat">
            <div className="boop-column">{session}</div>
          </div>
          {snapshot.drawer === 'work' ? (
            <WorkDrawer tasks={snapshot.tasks} selectedTaskId={snapshot.selectedTaskId} onClose={closeDrawer} onAction={onAction} />
          ) : null}
          {snapshot.drawer === 'settings' ? (
            <SettingsPanel home={snapshot.home} access={snapshot.access} onClose={() => props.controller.setDrawer('closed')} onAdvanced={() => props.controller.toggleAdvanced()} onSave={(mode, workspaceIds, sessionIds) => { void props.controller.saveAccess(mode, workspaceIds, sessionIds) }} />
          ) : null}
        </div>
      </section>
    </HomeUiProvider>
  )
}

export function BoopHomeSession(props: React.ComponentProps<typeof BoopSession>): React.ReactElement {
  return <BoopSession {...props} />
}

export { BoopUnavailable }

/**
 * BOOP client half, v0.2.
 *
 * The fixed entry opens the BOOP-owned main panel `boop.home`. It does not
 * call openSession and does not create a Session. Chat and input stay inside
 * the embedded conversation factory bound to the real home Session.
 * Ordinary DSH sessions are not restyled. Activation must not throw.
 */
import React from 'react'
import { BOOP_INTERACTION_CSS } from './interaction-styles.ts'
import { BoopEntryButton } from './header.tsx'
import { BoopSettingsRow } from './settings.tsx'
import { createMainSessionStore, type BoopCall } from './main-session.ts'
import { BoopHome, BoopHomeSession } from './home/index.tsx'
import { BOOP_HOME_CSS } from './home/home-styles.ts'
import { HOME_INTENT_KEY, HOME_PANEL_KEY, HomeController, type HomeHost, type RetainedSession } from './home/controller.ts'
import { insertDraftText, insertSessionReference, resolveDraftActions } from './home/draft-input.ts'

export const MAIN_KEY = HOME_PANEL_KEY
export const inject = ['slots', 'layout', 'connection', 'sessions', 'uiWorkspace', 'uiSession', 'uiConversation', 'conversation']

export function apply(ctx: any): void {
  try {
    applyInner(ctx)
  } catch (error) {
    console.error('[boop] activation failed; the app stays bootable', error)
  }
}

function applyInner(ctx: any): void {
  const call: BoopCall = async (endpoint, args) => {
    try {
      const result = await ctx.connection.rpc.call('/api', endpoint, { args: args ?? {} })
      return result ?? { ok: false }
    } catch (error) {
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
    }
  }
  const mainStore = createMainSessionStore({ mainSessionId: null })
  let controller: HomeController
  const host: HomeHost = {
    call,
    retain(sessionId, signal): RetainedSession {
      const ref = ctx.sessions.retain(sessionId, { source: 'boopHome', signal })
      return {
        id: sessionId,
        native: ref,
        ready: ref.ready,
        release() {
          try { ref.release() } catch { /* one release */ }
        },
      }
    },
    connection: {
      getSnapshot: () => ctx.connection?.state?.getSnapshot?.() ?? 'connected',
      subscribe: (listener) => ctx.connection?.state?.subscribe?.(listener) ?? (() => undefined),
      reconnect: () => { try { ctx.connection?.reconnect?.() } catch { /* host owns the error */ } },
    },
    selectPanel(id) {
      ctx.layout.selectPanel(id)
    },
    openSource(sessionId) {
      try { ctx.uiWorkspace.openSession(sessionId) } catch (error) {
        console.error('[boop] could not open source session', error)
      }
    },
    async insertReference(input) {
      try {
        const id = controller.getSnapshot().reference?.id ?? mainStore.getSnapshot()?.mainSessionId
        const actx = ctx.sessions.scope?.(id)
        const facade = ctx.conversation?.input?.for?.(actx)
        return insertSessionReference(resolveDraftActions(facade), input)
      } catch {
        return false
      }
    },
    async setDraftText(text) {
      try {
        const id = controller.getSnapshot().reference?.id ?? mainStore.getSnapshot()?.mainSessionId
        const actx = ctx.sessions.scope?.(id)
        const facade = ctx.conversation?.input?.for?.(actx)
        return insertDraftText(resolveDraftActions(facade), text)
      } catch {
        return false
      }
    },
  }
  controller = new HomeController(host)

  const rememberPanel = (id: string): void => {
    try { sessionStorage.setItem(HOME_INTENT_KEY, id) } catch { /* private mode */ }
  }
  try {
    const layout = ctx.layout
    if (layout && typeof layout.selectPanel === 'function' && layout.selectPanel.__boopTracked !== true) {
      const original = layout.selectPanel.bind(layout)
      const tracked = (id: string) => {
        if (typeof id === 'string' && id.length > 0) rememberPanel(id)
        return original(id)
      }
      tracked.__boopTracked = true
      layout.selectPanel = tracked
    }
  } catch { /* the host layout stays as it is */ }

  const openHome = (): { ok: true } => {
    try { rememberPanel(MAIN_KEY) } catch { /* private mode */ }
    try { ctx.layout.selectPanel(MAIN_KEY) } catch (error) {
      console.error('[boop] could not open the home panel', error)
    }
    return { ok: true }
  }

  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', 'boop/home')
    style.textContent = BOOP_HOME_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'boop: home styles')

  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', 'boop/interaction')
    style.textContent = BOOP_INTERACTION_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'boop: interaction styles')

  const Panel = (props: { SessionProvider?: React.ComponentType<any>; renderSlot?: (name: string, input?: Record<string, unknown>) => React.ReactElement }): React.ReactElement => {
    React.useEffect(() => {
      void controller.mount().then(() => {
        const home = controller.getSnapshot().home
        if (home && home.state === 'ready') {
          mainStore.set({
            mainSessionId: home.mainSessionId,
            phase: 'ready',
            error: null,
            identityConflict: false,
            host: {
              state: 'bound',
              mainSessionId: home.mainSessionId,
              scopeId: null,
              writable: true,
              durable: true,
              reason: null,
              storage: null,
            },
          })
        }
      })
      return () => controller.destroy()
    }, [])
    return <BoopHome controller={controller} SessionProvider={props.SessionProvider} renderSlot={props.renderSlot} />
  }

  ctx.effect(() => {
    const disposePanel = ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: MAIN_KEY,
      children: { 'boop.session': { kind: 'single', scope: 'session' } },
      inject: () => ({}),
    }, Panel))
    const disposeSession = ctx.slots.inject('boop.session', () => ctx.slots.register({
      name: 'boop.session',
      inject: () => ({}),
    }, BoopHomeSession))
    try {
      const remembered = sessionStorage.getItem(HOME_INTENT_KEY)
      if (remembered === MAIN_KEY) ctx.layout.selectPanel(MAIN_KEY)
    } catch { /* storage or layout may be absent in a test */ }
    return () => {
      disposeSession?.()
      disposePanel?.()
    }
  }, 'boop: home panel')

  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'boop-main',
      order: 50,
      label: 'BOOP · 波波',
      inject: () => ({ observer: mainStore, onOpen: openHome }),
    }, BoopEntryButton)),
    'boop: fixed entry',
  )

  ctx.effect(
    () => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'boop',
      order: 120,
      inject: () => ({
        observer: mainStore,
        call,
        onOpenMain: () => { openHome() },
        onOpenBoard: openHome,
      }),
    }, BoopSettingsRow)),
    'boop: settings row',
  )
}

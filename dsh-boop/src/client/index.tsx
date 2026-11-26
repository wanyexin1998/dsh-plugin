/**
 * BOOP client half.
 *
 * E04-01 batch 2 (main chat / initialization / sources):
 *  - the BOOP entry is a `sidebar.panellist` row above the workspaces. The
 *    host selects the `boop.tasks` panel; that panel immediately returns to the
 *    Conversation, opens the one BOOP main Session, and opens the native right
 *    Sidebar tab. It does not keep a second page on screen;
 *  - memory, tasks and settings live in that native right Sidebar as one tab
 *    type (`sidebarRightTabs`, kind `boop`). The initialization card is not
 *    mounted on the Conversation;
 *  - the host is reached through the authenticated connection RPC plane; the
 *    main-Session identity and source coverage endpoints are read-only/idempotent
 *    and never dispatch writes into a Session;
 *  - scoped styles are removed together with the plugin (FE-12);
 *  - activation is fully guarded: a throw here must never block web boot.
 */
import React from 'react'
import { BOOP_CSS } from './styles.ts'
import { BOOP_INTERACTION_CSS } from './interaction-styles.ts'
import { BOOP_CHAT_CSS } from './chat-styles.ts'
import { BoopMainHeader, BoopPanelIcon, watchMainSessionChatSkin, watchMainSessionSidebarHide } from './header.tsx'
import { BoopSideTab } from './side-tab.tsx'
import {
  createMainSessionStore,
  openMainSession,
  readCachedMainSessionId,
  resolveMainSessionIdentity,
  type BoopCall,
} from './main-session.ts'

export const MAIN_KEY = 'boop.tasks'
export const BOOP_TAB_ID = 'dsh-boop'
export const BOOP_TAB_KIND = 'boop'
/** Additive client services this plugin needs; a missing one parks the row. */
export const inject = ['slots', 'layout', 'connection', 'sessions', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs']

export function apply(ctx: any): void {
  try {
    applyInner(ctx)
  } catch (error) {
    console.error('[boop] activation failed; the app stays bootable', error)
  }
}

function applyInner(ctx: any): void {
  /** Host call over the authenticated connection; folds carrier faults into ok:false. */
  const call: BoopCall = async (endpoint, args) => {
    try {
      // The Gateway's wire payload is exactly one plain-object `args` field.
      const result = await ctx.connection.rpc.call('/api', endpoint, { args: args ?? {} })
      return result ?? { ok: false }
    } catch (error) {
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
    }
  }

  // Decoration hint only: the durable identity is the host ledger's binding.
  const mainStore = createMainSessionStore({ mainSessionId: readCachedMainSessionId() })

  const openMain = async (): Promise<{ ok: boolean; message?: string }> => {
    const outcome = await openMainSession({
      call,
      store: mainStore,
      sessions: ctx.sessions,
      uiWorkspace: ctx.uiWorkspace,
      selectAgentPreset: async (sessionId, presetId) => {
        const select = ctx.remote?.agentPresets?.select
        if (typeof select !== 'function') return { ok: false }
        return select(sessionId, presetId)
      },
    })
    if (!outcome.ok) {
      console.warn(`[boop] main session navigation failed (${outcome.reason}): ${outcome.message}`)
      return { ok: false, message: outcome.message }
    }
    return { ok: true }
  }

  /** Exact-id native jump; the Conversation keeps the target Session's draft. */
  const openSession = (sessionId: string): void => {
    try {
      ctx.uiWorkspace.openSession(sessionId)
    } catch (error) {
      console.error(`[boop] could not open source session ${JSON.stringify(sessionId)}`, error)
    }
  }

  const Panel = (): React.ReactElement => {
    React.useEffect(() => {
      try {
        ctx.layout.selectPanel(null)
      } catch (error) {
        console.error('[boop] could not return to the conversation', error)
      }
      void openMain().then((outcome) => {
        if (!outcome.ok) return
        try {
          ctx.sidebarRight?.openTab?.(BOOP_TAB_KIND)
        } catch (error) {
          console.error('[boop] could not open the right sidebar tab', error)
        }
      })
    }, [])
    return <></>
  }

  // Scoped styles; removed together with the plugin (FE-12).
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', 'boop/panel')
    style.textContent = BOOP_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'boop: panel styles')

  // BOOP-owned interaction surfaces: entry, header chip, init dock, source card.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', 'boop/interaction')
    style.textContent = BOOP_INTERACTION_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'boop: interaction styles')

  // Main-Session conversation skin. The header stamps `[data-boop-chat]` on
  // the native content root and `[data-boop-session]` on the phase frame so
  // the native AgentPresetLabel (a header sibling) can be hidden. Ordinary
  // Sessions never receive these marks.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', 'boop/chat')
    style.textContent = BOOP_CHAT_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'boop: main session chat styles')

  // Blank/hero chrome hides `conversation.session.header.actions`, so the chip
  // cannot be the only stamper. Match the Host-bound main Session id.
  ctx.effect(() => watchMainSessionChatSkin(mainStore), 'boop: main session chat skin mark')
  ctx.effect(() => watchMainSessionSidebarHide(mainStore), 'boop: hide main session from the workspace list')

  // Resolve the BOOP main-Session identity once on activation. This is a
  // read-mostly host call: it never navigates, creates a Session or changes the
  // selected panel, but it lets the decorations render on a restored page load.
  ctx.effect(() => {
    let disposed = false
    void resolveMainSessionIdentity({ call, store: mainStore })
      .then((outcome) => {
        if (disposed) return
        if (outcome.degraded) console.info('[boop] main session identity is degraded:', outcome.host?.reason ?? outcome.error)
      })
      .catch((error: unknown) => {
        if (disposed) return
        console.warn('[boop] main session identity resolution failed', error)
      })
    return () => {
      disposed = true
    }
  }, 'boop: main session identity')

  // The one BOOP panel: root-scoped `main` keyed slot, non-reserved key.
  ctx.effect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: MAIN_KEY,
            inject: () => ({}),
          },
          Panel,
        ),
      ),
    'boop: board panel',
  )

  // Native right Sidebar tab: memory, tasks, settings. The host draws the column.
  ctx.effect(() => {
    const disposeType = typeof ctx.sidebarRightTabs?.register === 'function'
      ? ctx.sidebarRightTabs.register({
          id: BOOP_TAB_ID,
          kind: BOOP_TAB_KIND,
          priority: 'extension',
          title: () => '波波',
          guide: [{
            id: 'boop',
            order: 40,
            title: () => '波波',
            description: () => '任务、记忆和设置',
          }],
        })
      : undefined
    const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: BOOP_TAB_ID,
          inject: () => ({
            observer: mainStore,
            call,
            onOpenSession: openSession,
            onOpenMain: () => void openMain(),
            sessionTools: {
              sessions: ctx.sessions,
              remote: ctx.remote,
              modelDirectories: ctx.modelDirectories,
            },
          }),
        },
        BoopSideTab,
      ),
    )
    const disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () =>
      ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab.title',
          key: BOOP_TAB_ID,
        },
        () => <span>波波</span>,
      ),
    )
    return () => {
      if (typeof disposeType === 'function') disposeType()
      if (typeof disposeBody === 'function') disposeBody()
      if (typeof disposeTitle === 'function') disposeTitle()
    }
  }, 'boop: side tab')

  // Entry above the workspaces. The host row selects `boop.tasks`; the panel
  // hands the page back to the Conversation and opens this tab.
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: MAIN_KEY,
            order: 20,
            label: 'BOOP · 波波',
          },
          BoopPanelIcon,
        ),
      ),
    'boop: workspace entry',
  )

  // Main-Session identity chip; renders nothing on ordinary Sessions.
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'boop-main',
            order: 900,
            label: 'BOOP',
            inject: () => ({ observer: mainStore, call }),
          },
          BoopMainHeader,
        ),
      ),
    'boop: main header identity',
  )
}

/**
 * BOOP client half.
 *
 * E04-01 batch 2 (main chat / initialization / sources):
 *  - the fixed BOOP entry (`sidebar.footer.action`) locates or creates exactly
 *    one native DSH Session and opens it through the native Conversation
 *    (`ctx.uiWorkspace.openSession`). BOOP owns no chat editor and no split view
 *    (FE-01/FE-02/FE-03); repeated clicks resolve to the same Session;
 *  - the initialization card lives in the additive `conversation.input.dock`
 *    seat and renders ONLY for the BOOP main Session; ordinary Sessions get no
 *    BOOP DOM at all;
 *  - the main-Session header identity chip is another additive session slot;
 *  - one additive BOOP row in the native Settings → General section (status +
 *    navigation only; native settings pages are never replaced);
 *  - `boop.tasks` stays the one root-scoped global panel (task board), with a
 *    `sidebar.panellist` icon entry — never the reserved `conversation` key;
 *  - the host is reached through the authenticated connection RPC plane; the
 *    main-Session identity and source coverage endpoints are read-only/idempotent
 *    and never dispatch writes into a Session;
 *  - scoped styles are removed together with the plugin (FE-12);
 *  - activation is fully guarded: a throw here must never block web boot.
 */
import React from 'react'
import { BoopBoard } from './board.tsx'
import { BOOP_CSS } from './styles.ts'
import { BOOP_INTERACTION_CSS } from './interaction-styles.ts'
import { BoopInitDock } from './init.tsx'
import { BoopEntryButton, BoopMainHeader, BoopPanelIcon } from './header.tsx'
import { BoopSettingsRow } from './settings.tsx'
import {
  createMainSessionStore,
  openMainSession,
  readCachedMainSessionId,
  resolveMainSessionIdentity,
  type BoopCall,
} from './main-session.ts'

export const MAIN_KEY = 'boop.tasks'
/** Additive client services this plugin needs; a missing one parks the row. */
export const inject = ['slots', 'layout', 'connection', 'sessions', 'uiWorkspace']

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

  const openBoard = (): void => {
    try {
      ctx.layout.selectPanel(MAIN_KEY)
    } catch (error) {
      console.error('[boop] could not open the board panel', error)
    }
  }

  const Panel = (): React.ReactElement => (
    <BoopBoard call={call} onOpenSession={openSession} onOpenMain={() => void openMain()} />
  )

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

  // Fixed BOOP entry: native navigation into the one BOOP main Session.
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'boop-main',
            order: 50,
            label: 'BOOP 主聊天',
            inject: () => ({ observer: mainStore, onOpen: openMain }),
          },
          BoopEntryButton,
        ),
      ),
    'boop: fixed entry',
  )

  // Global panel icon seating the board's `main` key (additive, root-scoped).
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: MAIN_KEY,
            order: 50,
            label: 'BOOP 任务板',
          },
          BoopPanelIcon,
        ),
      ),
    'boop: board icon',
  )

  // Initialization card: additive dock above the native composer, BOOP main
  // Session only. It never replaces the native input root (FE-03).
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'boop-init',
            order: -100,
            label: 'BOOP 初始化',
            inject: () => ({ observer: mainStore, call, onOpenBoard: openBoard }),
          },
          BoopInitDock,
        ),
      ),
    'boop: init dock',
  )

  // Main-Session identity chip + task entry; renders nothing on ordinary
  // Sessions (additive list slot, so no native header is replaced).
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'boop-main',
            order: 900,
            label: 'BOOP',
            inject: () => ({ observer: mainStore, call, onOpenBoard: openBoard }),
          },
          BoopMainHeader,
        ),
      ),
    'boop: main header identity',
  )

  // One additive row in the native Settings → General section. It shows real
  // facts and navigates; it writes no setting and replaces no native page.
  ctx.effect(
    () =>
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'boop',
            order: 120,
            inject: () => ({
              observer: mainStore,
              call,
              onOpenMain: () => void openMain(),
              onOpenBoard: openBoard,
            }),
          },
          BoopSettingsRow,
        ),
      ),
    'boop: settings row',
  )
}

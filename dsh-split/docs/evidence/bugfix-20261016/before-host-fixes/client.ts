/**
 * Client half of the workbench plugin.
 *
 * Responsibilities kept deliberately small and explicit:
 *  - own the layout state (`./layout`) and persist it under its own key;
 *  - claim the main content host by registering a `main` keyed seat and selecting it while
 *    at least one session panel is open (design: the frozen plan's F02/F09);
 *  - advertise the two contracts the patched host packages look for while it owns that host:
 *      `data-dsh-plugin-main-host` on <html> (patched ui-sidebar-right / ui-workspace),
 *      `[data-dsh-sidebar-host="<sessionId>"]` per mounted surface (patched ui-sidebar-right);
 *  - provide the *only* split entry point: the per-row menu in the left session list.
 *
 * Nothing here mounts a second editable presentation: the workbench renders each session
 * once, through the shipped conversation factory (F12).
 *
 * Review fixes (2026-10-15 audit):
 *  - the injected face is now LIVE (getters + subscribe/getVersion) instead of a one-shot
 *    snapshot; hooks have a stable identity (no effect churn, no updater side effects);
 *  - the menu row now LOCATES a session that is already on screen instead of disabling it
 *    (F10/N20: "已显示 B 只定位，不复制");
 *  - the picked direction (right/below) is forwarded per split (previously ignored);
 *  - dead code removed (no-op lifecycle effect, unused options parameter, unused injects).
 */
import React from 'react'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelRecord } from './layout'
import {
  close as closePanel,
  deserialize,
  emptyLayout,
  focus as focusPanel,
  focusOf,
  place,
  reveal,
  serialize,
  type LayoutState,
} from './layout'
import { Workbench, SessionConversation, announceSidebarHosts, type WorkbenchFace, type WorkbenchActions } from './workbench'
import { WORKBENCH_CSS } from './styles'

const NS = 'dsh-split'
const MAIN_KEY = 'dsh-split-workbench'
const STORAGE_KEY = 'dsh.split.workbench.v1'
const MAIN_HOST_MARKER = 'data-dsh-plugin-main-host'

/** Cordis services this plugin reads (a missing entry fails activation, not degrades). */
export const inject = ['slots', 'sessions', 'layout', 'uiSession', 'uiWorkspace', 'sidebarRight', 'locale']

export function apply(ctx: any): void {
  // Activation MUST NOT throw: a client entry that fails to activate blocks the whole web
  // boot (docs/evidence/incident-20261015-probe-web-boot.md). Any failure is reported and
  // the app keeps opening.
  try {
    applyInner(ctx)
  } catch (error) {
    console.error('[dsh-split] activation failed; the app stays bootable', error)
  }
}

function applyInner(ctx: any): void {
  /* --------------------------------------------------------------- state -- */

  let layout: LayoutState = (() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      return raw === null ? emptyLayout() : deserialize(JSON.parse(raw))
    } catch (error) {
      console.error('[dsh-split] stored layout could not be read', error)
      return emptyLayout()
    }
  })()

  let version = 0
  let pendingDirection: 'right' | 'below' = 'right'
  const listeners = new Set<() => void>()
  let saveTimer: number | null = null
  /** F07: per-session Sidebar collapsed state inside the workbench (never unmounted). */
  const collapsedSidebars = new Set<string>()

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-split] subscriber failed', error)
      }
    }
  }
  /** Bump subscribers without changing the layout (e.g. Sidebar collapse toggles). */
  function bump(): void {
    version += 1
    notify()
  }

  let hostAnnounceTimer: number | null = null
  /** Coalesced re-announce so the patched Sidebar re-measures its host width. */
  function scheduleSidebarHostAnnounce(): void {
    if (hostAnnounceTimer !== null) window.clearTimeout(hostAnnounceTimer)
    hostAnnounceTimer = window.setTimeout(() => {
      hostAnnounceTimer = null
      announceSidebarHosts()
    }, 100)
  }

  function persist(): void {
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      saveTimer = null
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(layout)))
      } catch (error) {
        console.error('[dsh-split] layout could not be saved', error)
      }
    }, 200)
  }

  function update(next: LayoutState): void {
    if (next === layout) return
    layout = next
    version += 1
    notify()
    persist()
    applyMainHostMarker()
  }

  /* ------------------------------------------------------- main host claim -- */

  /** Whether the plugin currently owns the main content host. */
  function isOwn(): boolean {
    try {
      return ctx.layout.panelInfo.getSnapshot().activePanelId === MAIN_KEY
    } catch (error) {
      return false
    }
  }

  /**
   * Tell the patched packages whether a plugin owns the main host: the right column stays
   * usable and session navigation must not yank the panel selection back.
   */
  function applyMainHostMarker(): void {
    try {
      const own = isOwn()
      if (own) document.documentElement.setAttribute(MAIN_HOST_MARKER, '')
      else document.documentElement.removeAttribute(MAIN_HOST_MARKER)
    } catch (error) {
      console.error('[dsh-split] marker update failed', error)
    }
  }

  function enterWorkbench(anchorSessionId: string | null): void {
    if (anchorSessionId !== null && layout.panels.length === 0) {
      update(place(layout, anchorSessionId).state)
    }
    try {
      ctx.layout.selectPanel(MAIN_KEY)
    } catch (error) {
      console.error('[dsh-split] could not select the workbench host', error)
    }
    applyMainHostMarker()
    announceSidebarHosts()
  }

  function leaveWorkbench(): void {
    try {
      ctx.layout.selectPanel(null)
    } catch (error) {
      console.error('[dsh-split] could not return to the conversation host', error)
    }
    applyMainHostMarker()
  }

  function closeOne(panelId: string): void {
    const { state } = closePanel(layout, panelId)
    update(state)
    if (state.panels.length === 0) leaveWorkbench()
  }

  /* ------------------------------------------------ focus follows the pane -- */

  /**
   * Keep the right column on the focused panel's session. Never navigate while collapsed;
   * the host's own session navigation is left untouched (patched ui-workspace keeps the
   * panel selection).
   */
  function syncRightbar(panelId: string): void {
    const panel = layout.panels.find((entry) => entry.id === panelId)
    if (panel === undefined) return
    let current: string | undefined
    try {
      current = ctx.uiSession.adapter.current.getSnapshot()?.key
    } catch (error) {
      current = undefined
    }
    if (current === panel.sessionId) return
    try {
      if (typeof ctx.sidebarRight.isExpanded === 'function' && ctx.sidebarRight.isExpanded() === false) return
    } catch (error) {
      /* an unreadable expansion state must not block navigation */
    }
    try {
      ctx.uiWorkspace.openSession(panel.sessionId)
    } catch (error) {
      console.error('[dsh-split] follow navigation failed', error)
    }
  }

  /* ------------------------------------------------------------- the entry -- */

  function currentSessionId(): string | null {
    try {
      return ctx.uiSession.adapter.current.getSnapshot()?.key ?? null
    } catch (error) {
      return null
    }
  }

  /** F09: split B right/below the captured anchor A. Disabled rows never reach here
      (already-shown, self-split and no-anchor are all gated in the menu face). */
  function splitFor(sessionId: string, direction: 'right' | 'below'): void {
    // Re-check at commit time (the menu face gate is render-time): an already-shown session
    // is only located — never duplicated (F12/N20, no silent locate).
    if (isShown(sessionId)) {
      locateOne(sessionId)
      return
    }
    const anchor = currentSessionId()
    pendingDirection = direction
    enterWorkbench(anchor)
    const focused = focusOf(layout)
    const index = layout.panels.findIndex((panel) => panel.id === focused)
    update(place(layout, sessionId, { at: index === -1 ? undefined : index + 1 }).state)
  }

  /** F10/N20: the dedicated locate row — already-shown sessions are only located. */
  function locateOne(sessionId: string): void {
    enterWorkbench(currentSessionId())
    update(reveal(layout, sessionId))
  }

  /* ----------------------------------------------------------- host wiring -- */

  const workbenchActions: WorkbenchActions = {
    retain: (sessionId) => {
      try {
        return ctx.sessions.retain(sessionId, { source: 'splitPane' })
      } catch (error) {
        console.error('[dsh-split] retain failed', sessionId, error)
        return null
      }
    },
    onFocus: (panelId) => {
      update(focusPanel(layout, panelId))
      syncRightbar(panelId)
    },
    onClose: (panelId) => closeOne(panelId),
    onToggleSidebar: (sessionId) => {
      if (collapsedSidebars.has(sessionId)) collapsedSidebars.delete(sessionId)
      else collapsedSidebars.add(sessionId)
      bump()
      // Re-measure: the patched Sidebar reads the host width per render, and a host that was
      // display:none measures 0; announce so it re-reads the 320px host right away.
      scheduleSidebarHostAnnounce()
    },
    onGeometryChange: () => {
      persist()
      // The patched Sidebar reads the host width per render; sash drags do not fire window
      // resize, so re-announce (coalesced) after real geometry changes (W014 step 4).
      scheduleSidebarHostAnnounce()
    },
  }

  /** The LIVE face injected into the `main` keyed seat. */
  const snapshot = (): WorkbenchFace => ({
    getPanels: () => layout.panels,
    getFocusedId: () => focusOf(layout),
    getPendingDirection: () => pendingDirection,
    isSidebarCollapsed: (sessionId) => collapsedSidebars.has(sessionId),
    subscribe,
    getVersion: () => version,
    // `hooks` is reserved by DSH's bindInjectSources for observable sources. A callback
    // object under that name is consumed by the renderer and never reaches Workbench.
    workbenchActions,
  })

  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', 'dsh-split/workbench')
    style.textContent = WORKBENCH_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'dsh-split: styles')

  // W028 recovery: a stored layout is only meaningful with its host. Without this, a restart
  // leaves the panes saved but invisible — the session menu then reports every stored session
  // as "already shown" (both split rows disabled, per the frozen splitUnavailable rule) while
  // the user sees the plain native view. Bring the workbench back, retrying briefly in case
  // the panel store is not ready yet at activation time.
  if (layout.panels.length > 0) {
    let attempts = 0
    const restoreHost = () => {
      attempts += 1
      try {
        if (layout.panels.length > 0 && !isOwn()) ctx.layout.selectPanel(MAIN_KEY)
      } catch (error) {
        console.error('[dsh-split] could not restore the workbench host', error)
      }
      applyMainHostMarker()
      if (!isOwn() && layout.panels.length > 0 && attempts < 3) window.setTimeout(restoreHost, 400)
    }
    window.setTimeout(restoreHost, 0)
  }

  // The workbench occupies the plugin's own `main` key; the host renders it on demand.
  // Persistence flush: a split/close made in the last 200ms before the window closes must
  // not be lost (design §4).
  ctx.effect(() => {
    const flush = () => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(layout)))
      } catch (error) {
        console.error('[dsh-split] layout flush failed', error)
      }
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      if (saveTimer !== null) window.clearTimeout(saveTimer)
      if (hostAnnounceTimer !== null) window.clearTimeout(hostAnnounceTimer)
      saveTimer = null
      hostAnnounceTimer = null
      flush()
    }
  }, 'dsh-split: persistence flush')

  ctx.effect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: MAIN_KEY,
            // A session-scoped child grants SessionProvider and binds the child's standard
            // useSession/useConversation hooks to the retained reference for each pane.
            children: { 'dsh-split.session': { kind: 'single', scope: 'session' } },
            inject: () => snapshot(),
          },
          Workbench,
        ),
      ),
    'dsh-split: workbench host',
  )

  ctx.effect(
    () => ctx.slots.inject('dsh-split.session', () =>
      ctx.slots.register({ name: 'dsh-split.session' }, SessionConversation),
    ),
    'dsh-split: session conversation',
  )

  // Panel selection drives the marker: the patched packages read it, nothing else does.
  ctx.effect(() => {
    const store = ctx.layout.panelInfo
    const sync = () => applyMainHostMarker()
    const dispose = typeof store.subscribe === 'function' ? store.subscribe(sync) : () => {}
    sync()
    return () => {
      dispose()
      // W029: disable/HMR while owning the host must not leave the marker behind —
      // the patched packages would stay in workbench mode with no seat behind it.
      try {
        document.documentElement.removeAttribute(MAIN_HOST_MARKER)
      } catch (error) {
        /* best effort */
      }
    }
  }, 'dsh-split: main host marker')

  // The ONLY split entry point: the per-row menu of the left session list (frozen F09).
  // The occupant must be a React COMPONENT rendering the shipped MenuItemButton — a plain
  // function returning props is not a component and never renders (that was the bug behind
  // "the split entry never showed up in the menu").
  function SplitMenuRow(props: {
    sessionId?: string
    useMenuOpenState: () => [unknown, (open: boolean) => void]
    labelKey: string
    run: (sessionId: string) => void
    separatorBefore: boolean
    canSplit: (sessionId: string | undefined) => boolean
    t: (key: string) => string
  }): React.ReactElement {
    const setMenuOpen = props.useMenuOpenState()[1]
    return React.createElement(
      MenuItemButton,
      {
        separatorBefore: props.separatorBefore,
        disabled: props.sessionId === undefined || !props.canSplit(props.sessionId),
        onSelect: () => {
          setMenuOpen(false)
          if (props.sessionId !== undefined) props.run(props.sessionId)
        },
      },
      props.t(props.labelKey),
    )
  }

  /** Frozen openSessionMenu: a separate locate row, rendered only when the session is
      already on screen. Returns null otherwise (renders nothing). */
  function LocateMenuRow(props: {
    sessionId?: string
    useMenuOpenState: () => [unknown, (open: boolean) => void]
    shown: (sessionId: string | undefined) => boolean
    run: (sessionId: string) => void
    t: (key: string) => string
  }): React.ReactElement | null {
    const setMenuOpen = props.useMenuOpenState()[1]
    if (props.sessionId === undefined || !props.shown(props.sessionId)) return null
    return React.createElement(
      MenuItemButton,
      {
        separatorBefore: true,
        onSelect: () => {
          setMenuOpen(false)
          if (props.sessionId !== undefined) props.run(props.sessionId)
        },
      },
      props.t('menu.locate'),
    )
  }

  ctx.effect(
    () =>
      ctx.locale.register(NS, {
        zh: {
          'menu.splitRight': '向右分屏',
          'menu.splitDown': '向下分屏',
          'menu.locate': '定位此会话',
          'note.shown': '该会话已在工作区显示，不会重复创建（可先在「定位此会话」里查看，或对另一个未显示的会话分屏）。',
          'note.noAnchor': '先打开一个会话，再从其它会话的菜单分屏。',
        },
        en: {
          'menu.splitRight': 'Split right',
          'menu.splitDown': 'Split down',
          'menu.locate': 'Locate session',
          'note.shown': 'This session is already shown in the workbench; it is never duplicated. Use "Locate session" to reveal it, or split from a session that is not shown.',
          'note.noAnchor': 'Open a session first, then split from another session’s menu.',
        },
      }),
    'dsh-split: locale',
  )

  const isShown = (sessionId: string | undefined): boolean =>
    typeof sessionId === 'string' && layout.panels.some((panel) => panel.sessionId === sessionId)

  /**
   * Frozen prototype's `.menu-note`: explains why the split rows are unavailable. The
   * shipped MenuItemButton drops extra props (no `title` pass-through), so the reason is a
   * note line in the same menu — the prototype carries one too.
   */
  function MenuNoteRow(props: {
    sessionId?: string
    shown: (sessionId: string | undefined) => boolean
    anchor: () => string | null
    t: (key: string) => string
  }): React.ReactElement | null {
    if (props.sessionId === undefined) return null
    const shown = props.shown(props.sessionId)
    const anchor = props.anchor()
    if (!shown && anchor !== null && anchor !== props.sessionId) return null
    return React.createElement(
      'div',
      {
        role: 'presentation',
        style: {
          padding: '6px 10px',
          fontSize: 11,
          lineHeight: 1.4,
          opacity: 0.6,
          maxWidth: 260,
          whiteSpace: 'normal',
        },
      },
      props.t(shown ? 'note.shown' : 'note.noAnchor'),
    )
  }

  // Dedicated locate row (frozen openSessionMenu): renders only for shown sessions.
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'dsh-split.locate',
            order: 290,
            locale: NS,
            inject: () => ({
              shown: isShown,
              run: (sessionId: string) => locateOne(sessionId),
            }),
          },
          LocateMenuRow,
        ),
      ),
    'dsh-split: menu locate',
  )

  // The note sits after both split rows, exactly like the prototype's `.menu-note`.
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'dsh-split.note',
            order: 320,
            locale: NS,
            inject: () => ({
              shown: isShown,
              anchor: currentSessionId,
            }),
          },
          MenuNoteRow,
        ),
      ),
    'dsh-split: menu note',
  )

  const menuEntries: Array<{ id: string; order: number; direction: 'right' | 'below'; labelKey: string }> = [
    { id: 'dsh-split.right', order: 300, direction: 'right', labelKey: 'menu.splitRight' },
    { id: 'dsh-split.down', order: 310, direction: 'below', labelKey: 'menu.splitDown' },
  ]
  for (const entry of menuEntries) {
    ctx.effect(
      () =>
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: entry.id,
              order: entry.order,
              locale: NS,
              inject: () => ({
                labelKey: entry.labelKey,
                // Prototype: one separator before the split group (the locate row above has
                // its own), none between the two split items.
                separatorBefore: entry.id === 'dsh-split.right',
                // F10: disabled with reason when there is no anchor, when the session is
                // already shown (use the locate row), or when splitting itself (no draft
                // pane is implemented; documented gap).
                canSplit: (sessionId: string | undefined) =>
                  typeof sessionId === 'string' && currentSessionId() !== null && !isShown(sessionId) && sessionId !== currentSessionId(),
                run: (sessionId: string) => splitFor(sessionId, entry.direction),
              }),
            },
            SplitMenuRow,
          ),
        ),
      'dsh-split: menu ' + entry.direction,
    )
  }

}

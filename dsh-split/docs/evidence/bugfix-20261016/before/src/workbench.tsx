/**
 * The workbench: one Dockview instance inside the plugin-owned main content host, and one
 * React surface per session panel.
 *
 * Division of labour (design: docs/design/p1-interfaces.md §1–§2)
 *  - Dockview owns geometry: which panel sits where, how big it is, moves, maximize.
 *  - This module owns identity: panel id ↔ session reference, focus, and the contracts the
 *    patched host packages look for:
 *      · `data-dsh-plugin-main-host` on <html> while the workbench holds the main content
 *        host (patched ui-sidebar-right keeps the right column, patched ui-workspace stops
 *        forcing the panel selection back);
 *      · `[data-dsh-sidebar-host="<sessionId>"]` for every mounted surface, plus a
 *        `dsh-sidebar-host-change` event when that set changes (patched ui-sidebar-right
 *        portals that session's Sidebar into it).
 *
 * Everything runs inside the slot runtime's React tree, so `SessionProvider` and
 * `renderFactorySlot` arrive as standard props — the shipped conversation factory is then
 * rendered exactly once per session (F12: one editable presentation per session).
 *
 * Review fixes (2026-10-15 audit rounds):
 *  - live face via useSyncExternalStore (no one-shot snapshot);
 *  - `setActivePanel()` — `activePanel` is getter-only in dockview-core 8.5.1, direct
 *    assignment throws in strict mode;
 *  - every group is created `locked: 'no-drop-target'` + `hideHeader: true` (design §1);
 *  - `hideBorders: true` + `theme.gap: 12` — no divider lines, frozen 12px transparent
 *    spacing (F06/V01);
 *  - references: diff-only retain/release per layout change; release-all only on unmount
 *    (W010: layout operations must not rebind unchanged sessions);
 *  - the requested direction (`right`/`below`) reaches each new group;
 *  - per-surface error boundary; portal slots disposed with their panels;
 *  - session title bar: letter chip, grip, close (stroke icon, aria-label), Sidebar
 *    show/hide entry (F07) — aligned to the frozen prototype.
 */
import React from 'react'
import ReactDOM from 'react-dom'
import { DockviewComponent } from 'dockview-core'
import type { PanelRecord } from './layout'

/** Options that hold the shipped geometry engine to the frozen restricted set.
 *  (Each one verified against dockview-core 8.5.1 dist/cjs/*.d.ts and main.cjs.js.) */
const ENGINE_OPTIONS = {
  singleTabMode: 'default',
  disableFloatingGroups: true,
  hideBorders: true,
  noPanelsOverlay: 'emptyGroup',
  // name/className are required by the DockviewTheme type; dockview only applies the class
  // to its container, nothing in the plugin or the app ships CSS for it (harmless).
  theme: { name: 'dsh-split-workbench', className: 'dsh-split-theme', gap: 12 },
} as const

export interface WorkbenchHooks {
  /** Retain a session for a panel; the reference is released when the panel closes. */
  retain(sessionId: string): { sessionId: string; release?: () => void } | null
  /** Focus changed (click, API). */
  onFocus(panelId: string): void
  /** The user asked to close a panel. */
  onClose(panelId: string): void
  /** Collapse/re-expand a session's Sidebar inside its pane (F07; never unmounts it). */
  onToggleSidebar(sessionId: string): void
  /** Dockview moved/resized panels: persist. */
  onGeometryChange(): void
}

/** The live face the client half injects into the `main` keyed seat. */
export interface WorkbenchFace {
  getPanels(): readonly PanelRecord[]
  getFocusedId(): string | null
  getPendingDirection(): 'right' | 'below'
  isSidebarCollapsed(sessionId: string): boolean
  subscribe(listener: () => void): () => void
  getVersion(): number
  hooks: WorkbenchHooks
}

export interface WorkbenchProps extends WorkbenchFace {
  /** Standard slot props (SessionProvider, renderFactorySlot, useSessions, …). */
  [key: string]: unknown
}

/** Notify the patched Sidebar package that the set of session hosts changed. */
export function announceSidebarHosts(): void {
  try {
    document.dispatchEvent(new CustomEvent('dsh-sidebar-host-change'))
  } catch (error) {
    /* events are best effort; the host simply keeps its previous placement */
  }
}

interface SurfaceSlot {
  panelId: string
  sessionId: string
  element: HTMLElement
}

/** W010: a crashing conversation must not take down the other sessions. */
class SurfaceBoundary extends React.Component<{ children?: React.ReactNode }, { failed: boolean }> {
  constructor(props: { children?: React.ReactNode }) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error('[dsh-split] a session surface crashed; the other sessions stay alive', error)
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return React.createElement('div', { className: 'dsh-split-empty' }, '该格渲染失败（其他会话不受影响）')
    }
    return this.props.children
  }
}

/**
 * Mirror of the shipped ConversationMainPanel's phase derivation (ui-conversation
 * lib/types/client/skeleton/ConversationMainPanel.js, 0.2.0-rc.2): the CALLER derives
 * settling/hero/active from the real session state — the factory consumes it. Hardcoding
 * `phase: 'settling'` leaves the composer seat `visibility:hidden` forever
 * (ConversationRoot.module.css: `[data-content-phase=settling] .composerSeat`).
 */
function conversationPhase(session: any, conversation: any): 'active' | 'engaging' | 'blank' {
  const activeTargets = conversation?.activeTargets?.size ?? 0
  return activeTargets > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
    ? 'active'
    : session.promptAttempted
      ? 'engaging'
      : 'blank'
}

function derivePhase(
  session: any,
  conversation: any,
  summaryBlank: unknown,
  sessionId: string | undefined,
): { phase: 'settling' | 'hero' | 'active'; hero: boolean } {
  const shellPhase = session === undefined || conversation === undefined ? 'blank' : conversationPhase(session, conversation)
  const openState = session?.openState
  const parentAvailabilityPending =
    session?.subagent?.address?.mode === 'continuable' && session?.subagent?.parentAvailable === undefined
  const settling =
    sessionId !== undefined &&
    ((shellPhase === 'blank' && openState === 'loading' && summaryBlank !== true) || parentAvailabilityPending)
  const hero = sessionId === undefined || (shellPhase === 'blank' && (openState === 'open' || summaryBlank === true))
  return { phase: settling ? 'settling' : hero ? 'hero' : 'active', hero }
}

/** Frozen prototype close glyph: stroke SVG `M4 4l9 9M13 4l-9 9` in a 17×17 viewBox. */
function CloseGlyph(): React.ReactElement {
  return React.createElement(
    'svg',
    { viewBox: '0 0 17 17', width: 15, height: 15, 'aria-hidden': true },
    React.createElement('path', {
      d: 'M4 4l9 9M13 4l-9 9',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      fill: 'none',
    }),
  )
}

/** Prototype grip: 6 dots at 13px width, 45% opacity. */
function GripGlyph(): React.ReactElement {
  return React.createElement(
    'svg',
    { viewBox: '0 0 13 16', width: 13, height: 16, 'aria-hidden': true },
    ...Array.from({ length: 6 }, (_, index) => {
      const x = index % 2 === 0 ? 4 : 9
      const y = 3 + Math.floor(index / 2) * 4
      return React.createElement('circle', { key: index, cx: x, cy: y, r: 1.1, fill: 'currentColor' })
    }),
  )
}

/** Frozen prototype sidebar toggle glyph: `M2 3h13v11H2zM10 3v11`. */
function SidebarGlyph(): React.ReactElement {
  return React.createElement(
    'svg',
    { viewBox: '0 0 17 17', width: 15, height: 15, 'aria-hidden': true },
    React.createElement('path', {
      d: 'M2 3h13v11H2zM10 3v11',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      fill: 'none',
      strokeLinejoin: 'round',
    }),
  )
}

/** One session panel: self-drawn title bar, the shipped conversation, and the Sidebar host. */
function Surface(props: {
  panelId: string
  sessionId: string
  focused: boolean
  hooks: WorkbenchHooks
  reference: { sessionId: string; release?: () => void } | null
  sidebarCollapsed: boolean
  runtime: Record<string, unknown>
}): React.ReactElement {
  const { panelId, sessionId, focused, hooks, reference, sidebarCollapsed, runtime } = props
  const SessionProvider = runtime.SessionProvider as React.ComponentType<Record<string, unknown>> | undefined
  const renderFactorySlot = runtime.renderFactorySlot as
    | ((name: string, props: Record<string, unknown>, locals?: Record<string, unknown>) => React.ReactNode)
    | undefined
  const useSessions = runtime.useSessions as ((select: (state: any) => unknown) => unknown) | undefined
  const useSession = runtime.useSession as ((select: (state: any) => unknown) => unknown) | undefined
  const useConversation = runtime.useConversation as ((select: (state: any) => unknown) => unknown) | undefined

  React.useEffect(() => {
    announceSidebarHosts()
    return () => {
      announceSidebarHosts()
    }
  }, [sessionId])

  const summary = (() => {
    if (typeof useSessions !== 'function') return undefined
    try {
      return useSessions((state: any) => state?.byId?.[sessionId]) as { title?: string; blank?: boolean } | undefined
    } catch (error) {
      return undefined
    }
  })()
  const title = summary?.title ?? sessionId
  const letter = (title.trim()[0] ?? '?').toUpperCase()

  // Derive the real composer phase from the live session state (never hardcoded):
  // settling while loading, hero for blank sessions, active once loaded.
  const session = useSession !== undefined ? (useSession((state: any) => state) as any) : undefined
  const conversation = useConversation !== undefined ? (useConversation((state: any) => state) as any) : undefined
  const { phase, hero } = derivePhase(session, conversation, summary?.blank, sessionId)

  return React.createElement(
    'div',
    {
      'data-dsh-split-surface': panelId,
      'data-dsh-split-focused': focused ? 'true' : 'false',
      // First click focuses (F05: the veil must not block it); already-focused clicks are
      // ignored so typing in the composer never triggers layout churn or navigation.
      onPointerDown: () => {
        if (!focused) hooks.onFocus(panelId)
      },
      style: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, height: '100%' },
    },
    React.createElement(
      'div',
      { 'data-dsh-split-titlebar': '' },
      React.createElement(
        'div',
        { className: 'dsh-split-title' },
        React.createElement('span', { 'data-dsh-split-grip': '' }, React.createElement(GripGlyph)),
        React.createElement('span', { 'data-dsh-split-letter': '' }, letter),
        React.createElement('span', { 'data-dsh-split-title-text': '' }, title),
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-split-icon',
          'data-action': 'sidebar',
          title: sidebarCollapsed ? '展开 Sidebar' : '收起 Sidebar',
          'aria-label': sidebarCollapsed ? '展开 Sidebar' : '收起 Sidebar',
          'aria-pressed': sidebarCollapsed ? 'false' : 'true',
          onClick: () => hooks.onToggleSidebar(sessionId),
        },
        React.createElement(SidebarGlyph),
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-split-icon',
          title: '关闭此会话视图，不删除会话',
          'aria-label': '关闭此会话视图，不删除会话',
          onClick: () => hooks.onClose(panelId),
        },
        React.createElement(CloseGlyph),
      ),
    ),
    React.createElement(
      'div',
      { 'data-dsh-split-body': '' },
      React.createElement(
        SurfaceBoundary,
        {},
        SessionProvider !== undefined && renderFactorySlot !== undefined && reference !== null
          ? React.createElement(
              SessionProvider,
              { session: reference },
              // Verified call shape: identical to the probe's W003-b second presentation,
              // which mounted and cleaned up correctly in the real app. The phase is DERIVED
              // from the live session state (settling → hero → active), never hardcoded.
              renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }),
            )
          : React.createElement('div', { className: 'dsh-split-empty' }, reference === null ? '无法保留该会话' : '缺少会话渲染面'),
      ),
      // The patched Sidebar package portals this session's Sidebar into this element.
      React.createElement('div', {
        'data-dsh-sidebar-host': sessionId,
        'data-dsh-sidebar-collapsed': sidebarCollapsed ? 'true' : 'false',
      }),
    ),
  )
}

/**
 * The workbench component. Rendered as the occupant of the plugin's `main` key; it creates
 * Dockview lazily, keeps it in sync with `panels`, and portals one Surface per panel into
 * the element Dockview handed to us.
 */
export function Workbench(props: WorkbenchProps): React.ReactElement {
  const face = props as WorkbenchFace

  // Live subscription to the layout store: splits, closes and focus changes after mount
  // must re-render this component (the pre-audit version read a one-shot snapshot instead).
  const subscribe = React.useCallback((listener: () => void) => face.subscribe(listener), [face])
  const version = React.useSyncExternalStore(subscribe, face.getVersion)
  const panels = face.getPanels()
  const focusedId = face.getFocusedId()
  const hooks = face.hooks
  void version

  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const apiRef = React.useRef<any>(null)
  const [slots, setSlots] = React.useState<SurfaceSlot[]>([])
  /** Last focus we told the host about: stops the Dockview ⇄ React echo loop. */
  const focusRef = React.useRef<string | null>(null)
  /** Live session references, keyed by sessionId (never touched inside a state updater). */
  const refsRef = React.useRef<Record<string, { sessionId: string; release?: () => void }>>({})
  const [, bumpReferences] = React.useState(0)
  const [engineError, setEngineError] = React.useState<string | null>(null)

  /* Dockview has no layout engine of its own before mount; create it once the host exists. */
  React.useEffect(() => {
    const host = hostRef.current
    if (host === null || apiRef.current !== null) return undefined
    let api: any = null
    try {
      api = new DockviewComponent(host, {
        ...ENGINE_OPTIONS,
        createComponent: (options: { id?: string; name?: string }) => {
          const panelId = String(options.id ?? options.name ?? '')
          const element = document.createElement('div')
          element.setAttribute('data-dsh-split-panel', panelId)
          element.style.cssText = 'height:100%;width:100%;overflow:hidden'
          setSlots((current) =>
            current.some((slot) => slot.panelId === panelId)
              ? current
              : [...current.filter((slot) => slot.panelId !== panelId), { panelId, sessionId: '', element }],
          )
          return {
            element,
            init: () => {},
            // Keep the slot registry in step with the engine: no portals to dead panels.
            dispose: () => {
              setSlots((current) => current.filter((slot) => slot.panelId !== panelId))
            },
          }
        },
      })
      api.onDidActivePanelChange?.(() => {
        try {
          const id = api.activePanel?.id
          // Echo gate: the sync effect writes activePanel too; without this comparison the
          // two would ping-pong and freeze the UI (observed 2026-10-15).
          if (typeof id === 'string' && focusRef.current !== id) {
            focusRef.current = id
            hooks.onFocus(id)
          }
        } catch (error) {
          /* focus is advisory */
        }
      })
      api.onDidLayoutChange?.(() => hooks.onGeometryChange())
      apiRef.current = api
      setEngineError(null)
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      console.error('[dsh-split] dockview failed to start', error)
      setEngineError(message)
    }
    return () => {
      try {
        apiRef.current?.dispose?.()
      } catch (error) {
        console.error('[dsh-split] dockview dispose failed', error)
      }
      apiRef.current = null
    }
  }, [hooks])

  /* References: retain on first sight, release when a session leaves the layout — diff
     only, so layout operations never rebind unchanged sessions (W010). Never inside a state
     updater: updaters must stay pure, and the host's retain was failing when called from
     one (observed 2026-10-15). useLayoutEffect: refs must exist before the first paint so
     no surface flashes the placeholder. */
  React.useLayoutEffect(() => {
    const map = refsRef.current
    let changed = false
    for (const panel of panels) {
      if (map[panel.sessionId] !== undefined) continue
      try {
        const reference = hooks.retain(panel.sessionId)
        if (reference === null) {
          console.error('[dsh-split] retain returned null for', panel.sessionId)
          continue
        }
        map[panel.sessionId] = reference
        changed = true
      } catch (error) {
        console.error('[dsh-split] retain failed', panel.sessionId, error)
      }
    }
    for (const key of Object.keys(map)) {
      if (panels.some((panel) => panel.sessionId === key)) continue
      try {
        map[key].release?.()
      } catch (error) {
        console.error('[dsh-split] release failed', key, error)
      }
      delete map[key]
      changed = true
    }
    if (changed) bumpReferences((value) => value + 1)
  }, [panels, hooks])

  /* Unmount only: release every still-held reference. This effect runs once; its cleanup
     must NOT run on layout changes, or every split/close would rebind all sessions. */
  React.useEffect(() => {
    return () => {
      const map = refsRef.current
      for (const key of Object.keys(map)) {
        try {
          map[key].release?.()
        } catch (error) {
          console.error('[dsh-split] release on unmount failed', key, error)
        }
        delete map[key]
      }
    }
  }, [])

  /* Keep Dockview in sync with the layout. Panels are added/removed; nothing is rebuilt. */
  React.useEffect(() => {
    const api = apiRef.current
    if (api === null) return
    try {
      const wanted = new Set(panels.map((panel) => panel.id))
      // Iterate a copy: removePanel splices the live array underneath a for..of.
      for (const existing of [...(api.panels ?? [])]) {
        if (!wanted.has(existing.id)) api.removePanel(existing)
      }
      const direction = face.getPendingDirection()
      let reference: string | undefined
      for (const panel of panels) {
        if ((api.panels ?? []).some((existing: { id: string }) => existing.id === panel.id)) {
          reference = panel.id
          continue
        }
        if (reference === undefined) {
          // First panel: the engine creates its group; restrict it right away (F02: one
          // session per group, no drop targets, header hidden).
          api.addPanel({ id: panel.id, component: 'surface', title: panel.sessionId })
          const added = (api.panels ?? []).find((existing: { id: string }) => existing.id === panel.id)
          if (added?.group !== undefined && added.group.locked !== 'no-drop-target') added.group.locked = 'no-drop-target'
          // hideHeader is creation-time only; the auto-created first group must be patched
          // after the fact, or the anchor pane shows a dockview tab strip.
          if (added?.group?.header !== undefined) added.group.header.hidden = true
        } else {
          // Honour the menu entry the user picked (向右 / 向下分屏); the new group carries
          // the frozen restrictions from birth.
          const referencePanel = (api.panels ?? []).find((existing: { id: string }) => existing.id === reference)
          const group = api.addGroup({
            referenceGroup: referencePanel.group,
            direction,
            locked: 'no-drop-target',
            hideHeader: true,
          })
          api.addPanel({ id: panel.id, component: 'surface', title: panel.sessionId, position: { referenceGroup: group } })
        }
        reference = panel.id
      }
      const target = focusedId ?? panels[0]?.id
      if (target !== undefined) {
        const found = (api.panels ?? []).find((existing: { id: string }) => existing.id === target)
        if (found !== undefined && api.activePanel?.id !== target) {
          focusRef.current = target
          // activePanel is getter-only in dockview-core 8.5.1; assignment throws in strict mode.
          api.setActivePanel(found)
        }
      }
      setSlots((current) => {
        let changed = false
        const next = current.map((slot) => {
          const record = panels.find((panel) => panel.id === slot.panelId)
          if (record === undefined || slot.sessionId === record.sessionId) return slot
          changed = true
          return { ...slot, sessionId: record.sessionId }
        })
        return changed ? next : current
      })
    } catch (error) {
      console.error('[dsh-split] dockview sync failed', error)
    }
  }, [face, panels, focusedId])

  /* One React portal per panel into the element Dockview owns for it. */
  const portals = slots
    .map((slot) => {
      const record = panels.find((panel) => panel.id === slot.panelId)
      if (record === undefined) return null
      const reference = refsRef.current[record.sessionId] ?? null
      return ReactDOM.createPortal(
        React.createElement(Surface, {
          panelId: record.id,
          sessionId: record.sessionId,
          focused: record.id === (focusedId ?? panels[0]?.id),
          hooks,
          reference,
          sidebarCollapsed: face.isSidebarCollapsed(record.sessionId),
          runtime: props,
        }),
        slot.element,
        record.id,
      )
    })
    .filter((node): node is React.ReactPortal => node !== null)

  return React.createElement(
    'div',
    { 'data-dsh-split-workbench': '', ref: hostRef },
    ...portals,
    engineError === null
      ? null
      : React.createElement('div', { className: 'dsh-split-engine-error' }, '分屏引擎启动失败：' + engineError),
  )
}

/**
 * dsh-split-probe — P0 runtime probe (W003 / W004 evidence collection).
 *
 * NOT production code. It answers, on the locked `0.2.0-rc.2` host, the questions
 * W002 could only answer statically:
 *
 *   W003-a  Selecting a plugin-owned `main` keyed slot: does it really unmount the
 *           native conversation presentation, and what happens to the native right
 *           column, `retainedBy.mainView`, and the native composer?
 *   W003-b  Presenting the same Session a second time (SessionProvider +
 *           `conversation.content` embedded): what happens to the FIRST editable
 *           root? W002-A reports that Lexical silently re-hosts the editor element.
 *           The probe captures node identity to prove or refute it, then checks that
 *           unmounting the copy gives the native root back.
 *   W004    Two Sidebars: what does the shipped right column do when the selected
 *           Session changes (background hidden vs. a second visible host), and does
 *           it survive a plugin-owned `main` panel?
 *
 * Every action is reversible: the panel selection returns to `null`, the copy is
 * unmounted and its Session reference released, navigation returns to the Session
 * it started from. Nothing is persisted; no native file is touched.
 *
 * Wiring note: the copy is rendered INSIDE the slot runtime's React tree (the panel
 * component receives `SessionProvider` / `renderFactorySlot` through the slot's
 * standard props because the entry declares a non-root-scope child slot). A private
 * `React.createRoot` would not receive those props.
 */

const React = require('react')
const h = React.createElement

/* Dockview is bundled into this entry (the host does not ship it). */
const { DockviewComponent } = require('dockview')
const dockviewCss = require('dockview/dist/styles/dockview.css')

const PANEL_ID = 'dsh-split-probe'
const WORKBENCH_KEY = 'dsh-split-probe-workbench'
const COPY_SLOT = 'probe.copy' /* declared child the overlay needs to receive session props */
const REFERENCE_SOURCE = 'dsh-split-probe'

/* ------------------------------------------------------------------ report -- */

const report = []
const listeners = new Set()

function json(value) {
  try {
    return JSON.stringify(value)
  } catch (error) {
    return String(value)
  }
}

/** Persisted mirror of the report: the developer can read it off disk, no copy/paste. */
const REPORT_KEY = 'dsh.split.probe.report'

function mirrorReport() {
  try {
    window.localStorage.setItem(REPORT_KEY, json({ probe: PANEL_ID, at: new Date().toISOString(), rows: report }))
  } catch (error) {
    /* storage may be unavailable; the panel remains the surface */
  }
}

function record(id, status, detail) {
  const entry = { id, status, detail }
  report.push(entry)
  mirrorReport()
  console.log('[dsh-split-probe] ' + id + ' [' + status + '] ' + json(detail))
  for (const listener of listeners) listener()
  return entry
}

function useReport() {
  const [, bump] = React.useState(0)
  React.useEffect(() => {
    const listener = () => bump((n) => n + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return report
}

/* ------------------------------------------------------------- measurement -- */

const frames = (count) =>
  new Promise((resolve) => {
    let left = count
    const step = () => {
      left -= 1
      if (left <= 0) resolve()
      else requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })

function snapshot(store) {
  try {
    if (store === undefined || store === null || typeof store.getSnapshot !== 'function') return null
    return store.getSnapshot()
  } catch (error) {
    return { error: String(error) }
  }
}

function names(value) {
  if (value === undefined || value === null) return []
  const found = new Set()
  for (const key of Object.getOwnPropertyNames(value)) found.add(key)
  let proto = Object.getPrototypeOf(value)
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) if (key !== 'constructor') found.add(key)
    proto = Object.getPrototypeOf(proto)
  }
  return [...found].sort()
}

/**
 * Derive the composer phase for the probe's second presentation from the live session
 * state (mirrors the shipped ConversationMainPanel): settling while loading, hero for a
 * blank session, active once loaded. Hardcoding 'settling' hides the composer seat
 * (`[data-content-phase=settling] .composerSeat { visibility: hidden }`).
 */
function copyPhase(props) {
  const sessionId = props.face === undefined || props.face === null || typeof props.face.currentSessionId !== 'function'
    ? undefined
    : props.face.currentSessionId()
  if (sessionId === undefined || sessionId === null) return 'hero'
  let session
  let conversation
  let summaryBlank
  try {
    if (typeof props.useSession === 'function') session = props.useSession((snapshot) => snapshot)
  } catch (error) { /* hook unavailable */ }
  try {
    if (typeof props.useConversation === 'function') conversation = props.useConversation((snapshot) => snapshot)
  } catch (error) { /* hook unavailable */ }
  try {
    if (typeof props.useSessions === 'function') summaryBlank = props.useSessions((state) => state?.byId?.[sessionId]?.blank)
  } catch (error) { /* hook unavailable */ }
  if (session === undefined || conversation === undefined) return summaryBlank === true ? 'hero' : 'active'
  const shellPhase = (conversation.activeTargets?.size ?? 0) > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
    ? 'active'
    : session.promptAttempted ? 'engaging' : 'blank'
  const openState = session.openState
  const pendingParent = session.subagent?.address?.mode === 'continuable' && session.subagent.parentAvailable === undefined
  const settling = shellPhase === 'blank' && openState === 'loading' && summaryBlank !== true || pendingParent
  const hero = shellPhase === 'blank' && (openState === 'open' || summaryBlank === true)
  return settling ? 'settling' : hero ? 'hero' : 'active'
}

function editorFacts() {
  const roots = [...document.querySelectorAll('[contenteditable="true"]')]
  // Lexical marks the ONE element it is bound to (client.js:9279 setAttribute in
  // setRootElement), and detaches the previous root — so this is the direct signal
  // for "which host owns the shared editor". The element ALSO carries the editor
  // instance back-reference (__lexicalEditor, cleared on unbind), which lets the probe
  // verify binding through editor.getRootElement() instead of counting DOM.
  const lexical = [...document.querySelectorAll('[data-lexical-editor="true"]')]
  const bound = lexical.length === 1 ? lexical[0] : null
  const editor = bound !== null && bound.__lexicalEditor !== undefined ? bound.__lexicalEditor : null
  return {
    editableRoots: roots.length,
    lexicalRoots: lexical.length,
    lexicalInProbe: lexical.filter((node) => node.closest('[data-split-probe]') !== null).length,
    lexicalInOverlay: lexical.filter((node) => node.closest('[data-shell-overlay]') !== null).length,
    // Instance-level truth: which element the shared editor is ACTUALLY bound to.
    boundRoot: bound === null
      ? null
      : { inProbe: bound.closest('[data-split-probe]') !== null, connected: bound.isConnected },
    editorAvailable: editor !== null && typeof editor.getRootElement === 'function',
    editorRootMatches: editor !== null && typeof editor.getRootElement === 'function' && editor.getRootElement() === bound,
    roots: roots.map((node) => {
      const box = node.getBoundingClientRect()
      return {
        tag: node.tagName.toLowerCase(),
        inProbe: node.closest('[data-split-probe]') !== null,
        connected: node.isConnected,
        size: Math.round(box.width) + 'x' + Math.round(box.height),
      }
    }),
  }
}

function rightbarFacts(ctx) {
  const column = document.querySelector('[data-rightbar-col]')
  const attrs = {}
  if (column !== null) for (const attr of column.attributes) attrs[attr.name] = attr.value
  const marked = []
  if (column !== null) {
    for (const node of [...column.querySelectorAll('*')].slice(0, 60)) {
      for (const attr of node.attributes) {
        if (attr.name.startsWith('data-sidebar') || attr.name.startsWith('data-rightbar')) {
          marked.push(attr.name + '=' + attr.value)
        }
      }
    }
  }
  let expanded = null
  try {
    expanded = ctx.sidebarRight !== undefined && typeof ctx.sidebarRight.isExpanded === 'function'
      ? ctx.sidebarRight.isExpanded()
      : null
  } catch (error) {
    expanded = 'error: ' + String(error)
  }
  return {
    columnAttrs: attrs,
    marked: [...new Set(marked)].slice(0, 14),
    sidebarRightExpanded: expanded,
  }
}

/** `retainedBy.mainView` is read in the frozen set but has no writer there. */
function retentionFacts(ctx, sessionId) {
  try {
    if (ctx.sessions === undefined || typeof ctx.sessions.retainInfo !== 'function') {
      return { available: false, reason: 'ctx.sessions.retainInfo missing' }
    }
    return { available: true, info: snapshot(ctx.sessions.retainInfo(sessionId)) }
  } catch (error) {
    return { available: false, reason: String(error) }
  }
}

function panelFacts(ctx) {
  const info = snapshot(ctx.layout.panelInfo)
  return {
    activePanelId: info === null ? null : info.activePanelId,
    panelInfoKeys: info === null ? null : Object.keys(info).slice(0, 10),
  }
}

/* ------------------------------------------------------------------ actions -- */

async function probeDiscovery(ctx) {
  const services = [
    'layout', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'uiWorkspace', 'uiConversation',
    'uiSession', 'slots', 'shortcuts', 'fileUpload', 'attachments', 'conversation',
  ]
  const found = {}
  for (const name of services) {
    let value = null
    try {
      value = ctx[name]
    } catch (error) {
      found[name] = 'error: ' + String(error)
      continue
    }
    found[name] = value === undefined || value === null ? String(value) : names(value).slice(0, 26)
  }
  const list = snapshot(ctx.sessions.list)
  const current = snapshot(ctx.uiSession === undefined ? null : ctx.uiSession.adapter?.current)
  record('W001/discovery', 'info', {
    reactVersion: React.version,
    services: found,
    panel: panelFacts(ctx),
    rightbar: rightbarFacts(ctx),
    sessionCount: list === null || !Array.isArray(list.ids) ? null : list.ids.length,
    sessionListKeys: list === null ? null : Object.keys(list).slice(0, 8),
    uiSessionCurrent: current,
    overlayPresent: document.querySelector('[data-shell-overlay]') !== null,
  })
  return 'info'
}

async function probeHostSwitch(ctx, face) {
  const sessionId = face.currentSessionId()
  const before = {
    panel: panelFacts(ctx),
    rightbar: rightbarFacts(ctx),
    retention: retentionFacts(ctx, sessionId),
    editors: editorFacts(),
    workbenchMounted: face.workbenchMounted(),
  }
  let selectError = null
  try {
    ctx.layout.selectPanel(WORKBENCH_KEY)
  } catch (error) {
    selectError = String(error)
  }
  await frames(4)
  const during = {
    panel: panelFacts(ctx),
    rightbar: rightbarFacts(ctx),
    retention: retentionFacts(ctx, sessionId),
    editors: editorFacts(),
    workbenchMounted: face.workbenchMounted(),
  }
  try {
    ctx.layout.selectPanel(null)
  } catch (error) {
    record('W003-a/restore-error', 'fail', String(error))
  }
  await frames(4)
  const after = {
    panel: panelFacts(ctx),
    rightbar: rightbarFacts(ctx),
    retention: retentionFacts(ctx, sessionId),
    editors: editorFacts(),
    workbenchMounted: face.workbenchMounted(),
  }
  const sameRetention = json(during.retention) === json(before.retention)
  const verdict = selectError !== null
    ? 'fail'
    : during.workbenchMounted === true && during.panel.activePanelId === WORKBENCH_KEY
      ? (sameRetention ? 'pass' : 'warn')
      : 'warn'
  record('W003-a/select-own-main-key', selectError === null ? 'info' : 'fail', {
    selectError, before, during, after, sameRetention,
  })
  record('W003-a/verdict', verdict, {
    read: 'workbench mounted while the key is selected; check retention, rightbar marks and editable roots',
  })
  return verdict
}

function probeSecondViewOpen(ctx, face) {
  const sessionId = face.currentSessionId()
  if (sessionId === null || sessionId === undefined) {
    record('W003-b/no-session', 'fail', 'no current session id available')
    return
  }
  const nativeRoot = document.querySelector('[data-lexical-editor="true"]')
  const nativeEditor = nativeRoot !== null && nativeRoot.__lexicalEditor !== undefined ? nativeRoot.__lexicalEditor : null
  let reference = null
  try {
    reference = ctx.sessions.retain(sessionId, { source: REFERENCE_SOURCE })
  } catch (error) {
    record('W003-b/retain-failed', 'fail', String(error))
    return
  }
  face.setCopy({ sessionId, reference, nativeRoot, nativeEditor, before: editorFacts() })
  record('W003-b/mounted-copy', 'info', { sessionId, before: editorFacts() })
}

async function probeSecondViewClose(ctx, face) {
  const copy = face.copy()
  if (copy === null) {
    record('W003-b/no-copy', 'warn', 'no copy is mounted')
    return
  }
  const during = editorFacts()
  const stolen = copy.nativeEditor !== null
    && typeof copy.nativeEditor.getRootElement === 'function'
    && copy.nativeRoot !== null
    && copy.nativeEditor.getRootElement() !== copy.nativeRoot
  face.setCopy(null)
  await frames(5)
  // OWNERSHIP RESTORE: the copy's ComposerContentEditable called setRootElement(null) on
  // unmount and the native composer's bind effect does not re-run — re-bind the shared
  // editor to the original element ourselves (instance captured via __lexicalEditor).
  let restored = null
  if (copy.nativeEditor !== null && typeof copy.nativeEditor.setRootElement === 'function') {
    if (copy.nativeRoot !== null && copy.nativeRoot.isConnected) {
      copy.nativeEditor.setRootElement(copy.nativeRoot)
      restored = copy.nativeEditor.getRootElement() === copy.nativeRoot
    } else {
      copy.nativeEditor.setRootElement(null)
      restored = 'native root detached; editor left unbound'
    }
  }
  const after = editorFacts()
  let released = null
  try {
    if (copy.reference !== null && typeof copy.reference.release === 'function') copy.reference.release()
    released = true
  } catch (error) {
    released = String(error)
  }
  const verdict = restored === true ? 'pass' : restored === false || stolen === false ? 'fail' : 'warn'
  record('W003-b/second-presentation', 'info', {
    sessionId: copy.sessionId,
    before: copy.before,
    during,
    after,
    nativeRootMovedOut: copy.nativeRoot !== null && copy.nativeRoot.isConnected === false,
    nativeRootConnectedAfterClose: copy.nativeRoot !== null ? copy.nativeRoot.isConnected : null,
    editorReboundToNativeRoot: restored,
    referenceReleased: released,
  })
  record('W003-b/verdict', verdict, {
    read: restored === true
      ? 'editor.getRootElement() returned to the native root after the copy closed — confirm by typing in the native composer'
      : stolen === false
        ? 'the copy never re-hosted the shared editor; confirm by typing in the native composer'
        : 'the shared editor was re-hosted by the copy and could not be returned to the native root (restored=' + String(restored) + ')',
  })
  return verdict
}

async function probeSidebarDual(ctx, face) {
  const currentId = face.currentSessionId()
  const list = snapshot(ctx.sessions.list)
  const ids = list === null || !Array.isArray(list.ids) ? [] : list.ids
  const other = ids.find((id) => id !== currentId)
  if (other === undefined) {
    record('W004/only-one-session', 'warn', { ids })
    return 'warn'
  }
  const before = { sessionId: currentId, rightbar: rightbarFacts(ctx) }
  let navigateError = null
  try {
    ctx.uiWorkspace.openSession(other)
  } catch (error) {
    navigateError = String(error)
  }
  await frames(5)
  const during = { sessionId: other, rightbar: rightbarFacts(ctx) }
  try {
    ctx.uiWorkspace.openSession(currentId)
  } catch (error) {
    record('W004/return-error', 'fail', String(error))
  }
  await frames(5)
  const after = { sessionId: currentId, rightbar: rightbarFacts(ctx) }
  record('W004/session-switch-sidebar', navigateError === null ? 'info' : 'fail', {
    navigateError, before, during, after, sessionIds: ids.length,
  })
  record('W004/verdict', 'info', {
    read: 'compare marked nodes + expansion across the switch; v5 needs a second VISIBLE per-session host',
  })
  return 'info'
}

/* ---------------------------------------------------------- W005: Dockview -- */

let dockState = null

function ensureDockCss() {
  if (document.querySelector('style[data-probe-dockview]') !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-probe-dockview', '')
  style.textContent = dockviewCss
  document.head.appendChild(style)
}

function makeMarker(label) {
  const node = document.createElement('div')
  node.setAttribute('data-probe-marker', label)
  node.textContent = 'dockview panel ' + label
  node.style.cssText = 'padding:10px;font-size:11px'
  return node
}

function disposeDockview() {
  if (dockState === null) {
    record('W005/nothing-to-dispose', 'warn', 'no dockview instance is alive')
    return 'warn'
  }
  try {
    dockState.api.dispose()
  } catch (error) {
    record('W005/dispose-failed', 'fail', String(error))
  }
  if (dockState.container.parentNode !== null) dockState.container.parentNode.removeChild(dockState.container)
  dockState = null
  record('W005/disposed', 'info', 'dockview instance disposed and its container removed')
  return 'info'
}

async function probeDockview(face) {
  const host = face.dockHost()
  if (host === null) {
    record('W005/no-host', 'fail', 'dockview container is not mounted')
    return 'fail'
  }
  if (dockState !== null) disposeDockview()
  ensureDockCss()
  const container = document.createElement('div')
  container.style.cssText = 'height:100%;width:100%'
  host.replaceChildren(container)
  const markers = new Map()
  const options = {
    singleTabMode: 'default',
    disableFloatingGroups: true,
    disableDnd: false,
    noPanelsOverlay: 'emptyGroup',
    hideBorders: false,
    createComponent: (opts) => {
      const id = String(opts.id !== undefined ? opts.id : (opts.name !== undefined ? opts.name : 'panel'))
      const node = makeMarker(id)
      markers.set(id, node)
      return { element: node, init: () => {}, dispose: () => {} }
    },
  }
  let api = null
  let constructError = null
  try {
    api = new DockviewComponent(container, options)
  } catch (error) {
    constructError = String(error)
  }
  if (api === null) {
    record('W005/construct-failed', 'fail', { constructError, options: Object.keys(options) })
    return 'fail'
  }
  const added = []
  // Source-level semantics (dockview-core 8.5.1): a group takes `locked`
  // (`boolean | 'no-drop-target'`, dockviewGroupPanelModel.d.ts:119) and
  // `hideHeader` (CoreGroupOptions, :27-35). Build one open group for the move
  // test and one locked + headerless group for the restricted-config test.
  let lockedGroup = null
  try {
    // Verified in Node (probe/tools/dockview-node-check.mjs): AddGroupOptions needs a
    // reference + direction before the group options apply.
    lockedGroup = api.addGroup({
      referenceGroup: api.groups[0],
      direction: 'right',
      locked: 'no-drop-target',
      hideHeader: true,
      id: 'probe-locked',
    })
  } catch (error) {
    record('W005/addGroup-failed', 'fail', { error: String(error) })
  }
  const plan = [
    { id: 'probe-a' },
    { id: 'probe-b' },
    { id: 'probe-c' },
    { id: 'probe-d', group: lockedGroup },
    { id: 'probe-e', group: lockedGroup },
  ]
  for (const item of plan) {
    try {
      api.addPanel({
        id: item.id,
        component: 'probe',
        title: item.id,
        ...(added.length === 0
          ? {}
          : item.group === undefined || item.group === null
            ? { position: { direction: 'within' } }
            : { position: { referenceGroup: item.group } }),
      })
      added.push(item.id)
    } catch (error) {
      record('W005/addPanel-failed', 'fail', { id: item.id, error: String(error) })
    }
  }
  await frames(3)
  const lockedFacts = (() => {
    if (lockedGroup === null) return null
    try {
      // The header ELEMENT still exists while hidden, so read the model, not node counts.
      return {
        lockedReadBack: lockedGroup.api.locked,
        headerHidden: lockedGroup.header === undefined || lockedGroup.header === null ? null : lockedGroup.header.hidden,
        lockedClass: lockedGroup.element === undefined || lockedGroup.element === null
          ? null
          : String(lockedGroup.element.className).includes('dv-locked-groupview'),
        modelOptions: lockedGroup.model === undefined ? null : lockedGroup.model.options,
      }
    } catch (error) {
      return { error: String(error) }
    }
  })()
  const before = {
    markers: markers.size,
    tabs: container.querySelectorAll('.dv-tab').length,
    groups: container.querySelectorAll('.dv-groupview').length,
  }
  let moveError = null
  try {
    const panel = api.panels.find((candidate) => candidate.id === 'probe-a')
    const target = api.panels.find((candidate) => candidate.id === 'probe-b')
    if (panel === undefined || target === undefined) throw new Error('getPanel returned undefined')
    panel.api.moveTo({ group: target.api.group, position: 'right' })
  } catch (error) {
    moveError = String(error)
  }
  await frames(3)
  const markerA = markers.has('probe-a') ? markers.get('probe-a') : null
  const after = {
    markers: markers.size,
    tabs: container.querySelectorAll('.dv-tab').length,
    groups: container.querySelectorAll('.dv-groupview').length,
    markerStillConnected: markerA === null ? null : markerA.isConnected,
    markerStillInContainer: markerA === null ? null : container.contains(markerA),
  }
  let maximize = null
  try {
    const panel = api.panels.find((candidate) => candidate.id === 'probe-a')
    api.maximizeGroup(panel)
    await frames(2)
    const during = container.querySelectorAll('.dv-maximized, .dv-groupview--maximized').length
    api.exitMaximizedGroup()
    await frames(2)
    maximize = { maximizedNodes: during, restoredNodes: container.querySelectorAll('.dv-maximized, .dv-groupview--maximized').length }
  } catch (error) {
    maximize = { error: String(error) }
  }
  let snapshot = null
  try {
    const raw = api.toJSON()
    snapshot = raw !== null && typeof raw === 'object' ? Object.keys(raw).slice(0, 8) : raw
  } catch (error) {
    snapshot = { error: String(error) }
  }
  const survived = after.markerStillConnected === true && after.markerStillInContainer === true
  const configFacts = { lockedGroup: lockedFacts, groupCount: container.querySelectorAll('.dv-groupview').length }
  record('W005/dockview-restricted', constructError === null && moveError === null && survived ? 'pass' : 'warn', {
    constructError,
    moveError,
    configFacts,
    added,
    before,
    after,
    componentSurvivedMove: survived,
    maximize,
    snapshotKeys: snapshot,
    dndCapabilities: api.dndCapabilities === undefined ? null : api.dndCapabilities,
  })
  record('W005/verdict', 'info', {
    read: 'restricted options accepted; compare tabs/groups and whether the component DOM node survived the move (no remove+add)',
  })
  dockState = { api, container }
  return survived ? 'pass' : 'warn'
}
/* ----------------------------------------------------------------- the panel -- */

const buttonStyle = {
  appearance: 'none',
  border: '0.5px solid var(--dsw-alias-border-l1)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-overlay)',
  color: 'var(--dsw-alias-label-primary)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
  padding: '3px 8px',
}

function ProbePanel(props) {
  // `ctx` is not a prop: the slot runtime hands the panel the injected face, and the
  // face carries the plugin context. (Found by tools/probe-dry-run.mjs.)
  const { face, SessionProvider, renderFactorySlot } = props
  const ctx = face === undefined || face === null ? undefined : face.ctx
  const rows = useReport()
  const [busy, setBusy] = React.useState(false)
  const [copy, setCopy] = React.useState(null)
  const [copyState, setCopyState] = React.useState('')
  const [manual, setManual] = React.useState('')

  React.useEffect(() => {
    // Defensive: if the probe is torn down mid-action, release the retained copy.
    return () => {
      const live = face.copy()
      if (live !== null && live.reference !== null && typeof live.reference.release === 'function') {
        try { live.reference.release() } catch (error) { /* best effort */ }
      }
      face.setCopy(null)
    }
  }, [face])

  React.useEffect(() => {
    panelRendered = true
  }, [])

  React.useEffect(() => {
    // One source of truth lives in `apply`; the panel only publishes its setter.
    face.attachCopyState = setCopy
    return () => {
      face.attachCopyState = null
    }
  }, [face])

  const run = (label, task) => async () => {
    if (ctx === undefined) {
      record(label + '/no-context', 'fail', 'the injected face did not carry ctx')
      return
    }
    setBusy(true)
    try {
      await task()
    } catch (error) {
      record(label + '/uncaught', 'fail', String(error && error.stack ? error.stack : error))
    } finally {
      setBusy(false)
    }
  }

  const copyReport = () => {
    const text = json({ probe: PANEL_ID, at: new Date().toISOString(), rows })
    const done = () => setCopyState('已复制 ' + rows.length + ' 条（直接粘贴给我）')
    if (copyText(text)) {
      done()
      return
    }
    try {
      if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(done, () => {
          console.log('[dsh-split-probe] report ' + text)
          setCopyState('复制被拒；已打印到控制台')
        })
        return
      }
    } catch (error) {
      /* fall through */
    }
    console.log('[dsh-split-probe] report ' + text)
    setCopyState('已打印到控制台（console）')
  }

  const recordManual = (verdict) => {
    record('W003-b/manual-typing', verdict, {
      note: verdict === 'pass'
        ? 'user reports the native composer still accepts input while the copy is mounted'
        : 'user reports the native composer misbehaves while the copy is mounted',
      editors: editorFacts(),
    })
    setManual(verdict === 'pass' ? '已记录：原生输入框正常' : '已记录：原生输入框异常')
  }

  return h('div', {
    'data-split-probe': '',
    style: {
      position: 'absolute',
      right: 12,
      bottom: 12,
      zIndex: 40,
      width: 400,
      maxHeight: '62vh',
      overflow: 'auto',
      padding: '10px 12px',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 8px 24px -8px rgba(0,0,0,.35)',
      fontSize: 11,
      lineHeight: 1.5,
      WebkitAppRegion: 'no-drag',
    },
  }, [
    h('div', { key: 'title', style: { fontWeight: 600, marginBottom: 4 } }, 'dsh-split P0 探针（W003 / W004）'),
    h('div', { key: 'warn', style: { opacity: 0.7, marginBottom: 8 } },
      '非生产代码。每一步都会自行还原；“3 第二份呈现”期间请顺手试一下原生输入框能否打字，然后点下面的按钮记录结论。'),
    h('div', { key: 'buttons', style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 } }, [
      h('button', { key: 'a', type: 'button', style: buttonStyle, disabled: busy, onClick: run('W001/discovery', () => probeDiscovery(ctx)) }, '1 能力发现'),
      h('button', { key: 'b', type: 'button', style: buttonStyle, disabled: busy, onClick: run('W003-a', () => probeHostSwitch(ctx, face)) }, '2 切到自建主面板'),
      h('button', { key: 'c', type: 'button', style: buttonStyle, disabled: busy, onClick: run('W003-b/open', () => probeSecondViewOpen(ctx, face)) }, '3 挂第二份呈现'),
      h('button', { key: 'd', type: 'button', style: buttonStyle, disabled: busy, onClick: run('W003-b/close', () => probeSecondViewClose(ctx, face)) }, '4 卸下并还原'),
      h('button', { key: 'e', type: 'button', style: buttonStyle, disabled: busy, onClick: run('W004', () => probeSidebarDual(ctx, face)) }, '5 Sidebar 切换'),
      h('button', { key: 'g', type: 'button', style: buttonStyle, disabled: busy, onClick: run('W005', () => probeDockview(face)) }, '6 Dockview 实测'),
      h('button', { key: 'h', type: 'button', style: buttonStyle, disabled: busy, onClick: run('W005/dispose', async () => { disposeDockview() }) }, '7 销毁 Dockview'),
      h('button', { key: 'f', type: 'button', style: buttonStyle, onClick: copyReport }, '复制报告'),
      h('button', { key: 'dl', type: 'button', style: buttonStyle, onClick: () => downloadReport() }, '下载报告'),
    ]),
    copyState === '' ? null : h('div', { key: 'copystate', style: { opacity: 0.75, marginBottom: 6 } }, copyState),
    (face.bootFailures ?? []).map((failure, index) => h('div', {
      key: 'bootfail-' + index,
      style: { color: '#e5484d', fontSize: 10, wordBreak: 'break-all', marginBottom: 4 },
    }, failure.label + ': ' + failure.error)),
    h('div', { key: 'manual', style: { display: 'flex', gap: 6, marginBottom: 6 } }, [
      h('button', { key: 'ok', type: 'button', style: buttonStyle, onClick: () => recordManual('pass') }, '输入框正常'),
      h('button', { key: 'bad', type: 'button', style: buttonStyle, onClick: () => recordManual('fail') }, '输入框异常'),
      manual === '' ? null : h('span', { key: 'note', style: { opacity: 0.75 } }, manual),
    ]),
    copy !== null && SessionProvider !== undefined && renderFactorySlot !== undefined
      ? h('div', {
        key: 'copy',
        'data-split-probe-copy': '',
        style: {
          height: 280,
          overflow: 'hidden',
          border: '0.5px solid var(--dsw-alias-border-l1)',
          borderRadius: 8,
          margin: '6px 0',
        },
      }, h(SessionProvider, { session: copy.reference },
        renderFactorySlot('conversation.content', {
          variant: 'embedded',
          phase: copyPhase(props),
          hero: copyPhase(props) === 'hero',
        })))
      : null,
    h('div', {
      key: 'dock',
      'data-probe-dock': '',
      ref: (node) => { face.setDockHost(node) },
      style: { height: 240, margin: '6px 0', border: '0.5px solid var(--dsw-alias-border-l1)', borderRadius: 8, overflow: 'hidden' },
    }),
    h('pre', {
      key: 'dump',
      'data-probe-report': '',
      style: {
        userSelect: 'text',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        font: '10px/1.4 ui-monospace, monospace',
        maxHeight: '22vh',
        overflow: 'auto',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        padding: 6,
        margin: '6px 0 0',
      },
    }, json({ probe: PANEL_ID, at: new Date().toISOString(), rows })),
    h('ol', { key: 'rows', style: { margin: 0, paddingLeft: 16 } },
      rows.map((row, index) => h('li', { key: index, style: { marginBottom: 4 } }, [
        h('code', { key: 'id', style: { fontSize: 10 } }, row.id),
        ' — ',
        h('b', {
          key: 'status',
          style: { color: row.status === 'fail' ? '#e5484d' : row.status === 'pass' ? '#30a46c' : 'inherit' },
        }, row.status),
        h('div', { key: 'detail', style: { opacity: 0.7, wordBreak: 'break-all', fontSize: 10 } },
          json(row.detail).slice(0, 700)),
      ]))),
  ])
}

/** The plugin-owned main presentation; mounted only while its key is selected. */
function ProbeWorkbench(props) {
  const face = props.face
  React.useEffect(() => {
    face.markWorkbench(true)
    return () => face.markWorkbench(false)
  }, [face])
  return h('div', {
    'data-split-probe-workbench': '',
    style: { display: 'grid', placeItems: 'center', height: '100%', fontSize: 12, opacity: 0.8 },
  }, 'dsh-split-probe：插件占用的 main 键位（原生会话呈现此刻应已卸载）')
}

/** Occupant of the declared child slot; exists so the entry receives session props. */
function ProbeCopySlot() {
  return null
}

/* -------------------------------------------------------------------- apply -- */

/* -------------------------------------------------------------------- apply -- */

/**
 * Save the report to a file. The clipboard API is refused in the `dsh-app://` context,
 * and a rendered object reads as "[object Object]", so the reliable channel back to the
 * developer is a downloaded file (it lands in the user's Downloads folder).
 */
function downloadReport() {
  try {
    const text = json({ probe: PANEL_ID, at: new Date().toISOString(), rows: report })
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'p0-probe-report.json'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    return true
  } catch (error) {
    record('report/download-failed', 'fail', String(error && error.message ? error.message : error))
    return false
  }
}

/**
 * Copy text without the async clipboard API. `navigator.clipboard` is refused in the
 * `dsh-app://` context, but a real selection + `execCommand('copy')` still works inside
 * Electron, which is the only reliable way to get the report out of the panel.
 */
function copyText(text) {
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch (error) {
    return false
  }
}

/** Registration failures seen while activating; surfaced by the fallback panel. */
const bootFailures = []
/** Set by the React panel's first effect, so we know it really made it on screen. */
let panelRendered = false

/**
 * Slot-free, React-free panel built from plain DOM.
 *
 * Two jobs: (1) an entry that fails to activate blocks the whole web boot
 * (docs/evidence/incident-20261015-probe-web-boot.md), so `apply` must never throw —
 * this panel is the guaranteed surface; (2) when a slot registration is rejected we
 * want to SEE the reason instead of guessing.
 */
function mountFallbackPanel(ctx, face, failures) {
  if (document.querySelector('[data-split-probe-fallback]') !== null) return
  try {
    const wrap = document.createElement('div')
    wrap.setAttribute('data-split-probe-fallback', '')
    wrap.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483000;width:380px;max-height:52vh;overflow:auto;padding:10px 12px;border:0.5px solid #666;border-radius:10px;background:#1c1c1e;color:#f2f2f7;font:11px/1.5 system-ui;box-shadow:0 8px 24px -8px rgba(0,0,0,.6)'
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = '✕ 关闭'
    close.style.cssText = 'float:right;font:inherit;padding:2px 6px;border-radius:6px;border:0.5px solid #666;background:transparent;color:inherit;cursor:pointer'
    close.onclick = () => { wrap.remove() }
    const title = document.createElement('div')
    title.style.cssText = 'font-weight:600;margin-bottom:6px'
    title.textContent = 'dsh-split P0 探针（降级面板）'
    const note = document.createElement('div')
    note.style.cssText = 'opacity:.75;margin-bottom:8px'
    note.textContent = failures.length === 0
      ? '面板插槽已注册，但 React 面板未出现在屏幕上；这里提供不依赖插槽的动作。'
      : '面板插槽注册失败（原因见下）。这里提供不依赖插槽的动作；"3/4 第二份呈现"需要插槽，暂不可用。'
    wrap.appendChild(close)
    wrap.appendChild(title)
    wrap.appendChild(note)
    for (const failure of failures) {
      const row = document.createElement('div')
      row.style.cssText = 'color:#ff6369;font-size:10px;word-break:break-all;margin-bottom:4px'
      row.textContent = failure.label + ': ' + failure.error
      wrap.appendChild(row)
    }
    const bar = document.createElement('div')
    bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px'
    const buttons = [
      ['1 能力发现', () => probeDiscovery(ctx)],
      ['2 切到自建主面板', () => probeHostSwitch(ctx, face)],
      ['5 Sidebar 切换', () => probeSidebarDual(ctx, face)],
      ['6 Dockview 实测', () => probeDockview(face)],
      ['7 销毁 Dockview', () => Promise.resolve(disposeDockview())],
      ['下载报告', () => Promise.resolve(downloadReport())],
    ]
    for (const [label, task] of buttons) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.style.cssText = 'font:inherit;padding:3px 8px;border-radius:6px;border:0.5px solid #666;background:transparent;color:inherit;cursor:pointer'
      button.onclick = () => {
        Promise.resolve()
          .then(task)
          .catch((error) => record('fallback/' + label, 'fail', String(error && error.message ? error.message : error)))
      }
      bar.appendChild(button)
    }
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.textContent = '复制报告'
    copy.style.cssText = 'font:inherit;padding:3px 8px;border-radius:6px;border:0.5px solid #666;background:transparent;color:inherit;cursor:pointer;margin-bottom:6px'
    copy.onclick = () => {
      const text = reportText()
      if (copyText(text)) {
        copy.textContent = '已复制 ✓'
        setTimeout(() => { copy.textContent = '复制报告' }, 2000)
        return
      }
      // Last resort: show it in the selectable dump so the user can copy by hand.
      dump.textContent = text
      copy.textContent = '请在下方文本块手动复制'
    }
    // The full report as selectable text: the clipboard API can be refused, and a
    // rendered object would read as "[object Object]".
    const dump = document.createElement('pre')
    dump.setAttribute('data-probe-report', '')
    dump.style.cssText = 'user-select:text;white-space:pre-wrap;word-break:break-all;font:10px/1.4 ui-monospace,monospace;max-height:24vh;overflow:auto;border:0.5px solid #666;border-radius:6px;padding:6px;margin:6px 0 0'
    const reportText = () => json({ probe: PANEL_ID, at: new Date().toISOString(), rows: report })
    const list = document.createElement('ol')
    list.style.cssText = 'margin:0;padding-left:16px'
    const render = () => {
      list.textContent = ''
      dump.textContent = reportText()
      for (const row of report) {
        const item = document.createElement('li')
        item.style.cssText = 'margin-bottom:4px;word-break:break-all'
        item.textContent = row.id + ' [' + row.status + '] ' + json(row.detail).slice(0, 400)
        list.appendChild(item)
      }
    }
    render()
    listeners.add(render)
    wrap.appendChild(bar)
    wrap.appendChild(copy)
    wrap.appendChild(list)
    wrap.appendChild(dump)
    document.body.appendChild(wrap)
  } catch (error) {
    console.error('[dsh-split-probe] fallback panel failed', error)
  }
}

/**
 * Services this plugin reads. Cordis refuses any `ctx.<service>` access that was not
 * declared here ("cannot get property … without inject"), so a missing list does not
 * degrade — it fails ACTIVATION and, on the client, blocks the whole web boot. That is
 * exactly what happened on 2026-10-15/16 until the slot-free fallback panel reported it.
 */
exports.inject = ['slots', 'sessions', 'layout', 'uiSession', 'uiWorkspace', 'sidebarRight']

exports.apply = function apply(ctx) {
  let workbench = false
  let dockHost = null
  let copy = null
  const face = {
    ctx,
    workbenchMounted: () => workbench,
    markWorkbench: (value) => { workbench = value },
    copy: () => copy,
    attachCopyState: null,
    setCopy: (value) => {
      copy = value
      if (typeof face.attachCopyState === 'function') face.attachCopyState(value)
    },
    dockHost: () => dockHost,
    setDockHost: (node) => { dockHost = node },
    currentSessionId: () => {
      try {
        const info = snapshot(ctx.layout.panelInfo)
        if (info !== null && typeof info.activeSessionId === 'string') return info.activeSessionId
        const current = snapshot(ctx.uiSession === undefined ? null : ctx.uiSession.adapter?.current)
        if (current !== null && typeof current.key === 'string') return current.key
        const list = snapshot(ctx.sessions.list)
        if (list !== null && Array.isArray(list.ids) && list.ids.length > 0) return list.ids[0]
      } catch (error) {
        bootFailures.push({ label: 'currentSessionId', error: String(error && error.message ? error.message : error) })
      }
      return null
    },
  }

  const attempt = (label, task) => {
    try {
      return task()
    } catch (error) {
      bootFailures.push({ label, error: String(error && error.message ? error.message : error) })
      return null
    }
  }

  // Activation MUST NOT throw: a failed entry blocks the entire web boot.
  try {
    attempt('shell.overlay 面板', () => ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: PANEL_ID,
      order: 90,
      children: { [COPY_SLOT]: { kind: 'single', scope: 'session' } },
      inject: () => ({ face }),
    }, ProbePanel)), 'dsh-split-probe: panel'))

    attempt('probe.copy 子槽', () => ctx.effect(() => ctx.slots.inject(COPY_SLOT, () => ctx.slots.register({
      name: COPY_SLOT,
    }, ProbeCopySlot)), 'dsh-split-probe: copy slot'))

    attempt('main 键位', () => ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: WORKBENCH_KEY,
    }, () => h(ProbeWorkbench, { face }))), 'dsh-split-probe: workbench key'))
  } catch (error) {
    bootFailures.push({ label: 'apply', error: String(error && error.message ? error.message : error) })
  }

  face.bootFailures = bootFailures
  if (bootFailures.length > 0) console.error('[dsh-split-probe] registration failures', bootFailures)

  // Exactly ONE panel on screen. The React panel is the primary surface and shows any
  // registration failure itself; the slot-free panel exists only for the case where the
  // React panel never reaches the screen — otherwise the two would overlap (the
  // fallback sits far above it in z-order).
  setTimeout(() => {
    if (!panelRendered) mountFallbackPanel(ctx, face, bootFailures)
  }, 2500)
}
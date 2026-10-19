/**
 * Offline contract harness. The complete installed rc.2 renderer and SlotCore are
 * read from app.asar and executed without changing the installation. Cordis's
 * effect owner, domain session sources, the conversation body, and Dockview's
 * geometry are synthetic; React, portals, SlotRegistry, inject binding, child
 * authorization, scope providers, and factory dispatch are real.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { readDockviewCss } from '../../tools/dockview-css.mjs'

const require = createRequire(import.meta.url)
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ASAR = process.env.DSH_ASAR ?? 'E:/deepseek-harness/resources/app.asar'
const RENDERER = '/dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js'
const SLOTS = '/dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js'

function readPackedEntry(entryPath) {
  const fd = fs.openSync(ASAR, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, head.length, 0)
    const json = Buffer.alloc(head.readUInt32LE(12))
    fs.readSync(fd, json, 0, json.length, 16)
    let entry = JSON.parse(json.toString('utf8'))
    for (const segment of entryPath.split('/').filter(Boolean)) entry = entry?.files?.[segment]
    if (!entry || entry.unpacked || entry.offset === undefined) throw new Error(`packed ASAR entry missing: ${entryPath}`)
    const body = Buffer.alloc(entry.size)
    fs.readSync(fd, body, 0, body.length, 8 + head.readUInt32LE(4) + Number(entry.offset))
    return body
  } finally {
    fs.closeSync(fd)
  }
}

const rendererBytes = readPackedEntry(RENDERER)
const slotsBytes = readPackedEntry(SLOTS)
const rendererSource = rendererBytes.toString('utf8')
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
export const artifactEvidence = {
  asar: ASAR,
  renderer: { entry: RENDERER, sha256: sha256(rendererBytes), bytes: rendererBytes.length },
  slots: { entry: SLOTS, sha256: sha256(slotsBytes), bytes: slotsBytes.length },
  diagnosticLines: Object.fromEntries(['bindInjectSources', 'standardKit', 'scopeAreaProvider', 'SessionEntry'].map((name) => [
    name, rendererSource.slice(0, rendererSource.indexOf(`function ${name}(`)).split('\n').length,
  ])),
}

const shippedSlots = await import(`data:text/javascript;base64,${slotsBytes.toString('base64')}`)

export function observable(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    set(next) { state = next; for (const listener of [...listeners]) listener() },
    get subscriberCount() { return listeners.size },
  }
}

function effectContext(name) {
  const roots = []
  let parent = roots
  return {
    fiber: { name },
    emit() {},
    reflect: { provide() {} },
    effect(run) {
      const children = []
      const oldParent = parent
      parent = children
      let cleanup
      try { cleanup = run() } finally { parent = oldParent }
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        if (typeof cleanup === 'function') cleanup()
        else if (cleanup?.[Symbol.iterator]) for (const item of [...cleanup].reverse()) item?.()
        for (const child of [...children].reverse()) child()
      }
      oldParent.push(dispose)
      return dispose
    },
    dispose() { for (const dispose of [...roots].reverse()) dispose() },
  }
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="test-root"></div></body></html>', {
    url: 'https://dsh-contract.invalid/', pretendToBeVisual: true,
  })
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'Event', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

class FakeService {
  constructor(ctx, name) { this.ctx = ctx; ctx[name] = this }
}

function loadShippedRenderer(React, diagnosticConsole) {
  let result
  // Diagnostics only add exports; no shipped implementation is replaced.
  const marker = '\t\treturn module.exports;'
  if (rendererSource.split(marker).length !== 2) throw new Error('renderer export seam changed; review harness')
  const instrumented = rendererSource.replace(marker,
    '\t\texports.__contract = { runInject, standardKit };\n' + marker)
  vm.runInNewContext(instrumented, {
    window: { ...window, document, __ModuleLoader__: { load({ factory }) {
      result = factory((name) => {
        if (name === '@deepseek-ai/dsh-client-ui-slots') return shippedSlots
        if (name === '@deepseek-ai/cordis') return { Service: FakeService }
        if (name === 'react') return React
        if (name.startsWith('react-dom') || name === 'react/jsx-runtime') return require(name)
        throw new Error(`unexpected renderer dependency: ${name}`)
      })
    } } },
    document, console: diagnosticConsole, queueMicrotask, setTimeout, clearTimeout,
  }, { filename: `${ASAR}!${RENDERER}` })
  return result
}

function geometryDouble() {
  const instances = []
  class DockviewComponent {
    constructor(host, options) {
      this.host = host
      this.options = options
      this.panels = []
      this.groups = []
      this.active = []
      this.layoutListeners = []
      this.disposed = false
      instances.push(this)
    }
    onDidActivePanelChange(fn) { this.active.push(fn); return { dispose() {} } }
    onDidLayoutChange(fn) { this.layoutListeners.push(fn); return { dispose() {} } }
    addGroup(options) {
      const group = { ...options, header: { hidden: options.hideHeader } }
      this.groups.push(group)
      return group
    }
    addPanel(options) {
      const component = this.options.createComponent({ id: options.id, name: options.component })
      const panel = { ...options, component, group: options.position?.referenceGroup ?? this.addGroup({}) }
      this.panels.push(panel)
      this.host.appendChild(component.element)
      component.init?.({})
      return panel
    }
    removePanel(panel) {
      this.panels = this.panels.filter((item) => item !== panel)
      panel.component.dispose()
      panel.component.element.remove()
    }
    setActivePanel(panel) { this.activePanel = panel; for (const listener of this.active) listener() }
    dispose() {
      this.disposed = true
      for (const panel of [...this.panels]) this.removePanel(panel)
    }
  }
  return { instances, DockviewComponent }
}

async function compilePlugin(React, geometry, sourceDirectory, diagnosticConsole) {
  const sourceOverrides = sourceDirectory ? [{
    name: 'before-source-overlay',
    setup(builder) {
      builder.onLoad({ filter: /[/\\]src[/\\].*\.tsx?$/ }, async ({ path: sourcePath }) => {
        const candidate = path.join(sourceDirectory, path.basename(sourcePath))
        if (!fs.existsSync(candidate)) return undefined
        return { contents: fs.readFileSync(candidate, 'utf8'), loader: sourcePath.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: path.dirname(sourcePath) }
      })
    },
  }] : []
  const compiled = await build({
    absWorkingDir: projectRoot, entryPoints: ['src/client.ts'], bundle: true, write: false,
    format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'transform', logLevel: 'silent',
    define: { __DSH_SPLIT_DOCKVIEW_CSS__: JSON.stringify(readDockviewCss()) },
    external: ['react', 'react-dom', 'dockview-core', '@deepseek-ai/dsh-client-ui-primitives'], plugins: sourceOverrides,
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'console', compiled.outputFiles[0].text)((name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return require('react-dom')
    if (name === 'dockview-core') return geometry
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MenuItemButton: ({ onSelect, ...props }) => React.createElement('button', { ...props, onClick: onSelect }) }
    throw new Error(`unexpected plugin dependency: ${name}`)
  }, module, module.exports, diagnosticConsole)
  return module.exports
}

export async function createHarness({ sourceDirectory, restoreSessions = [], withheldSessions = [] } = {}) {
  const dom = installDom()
  const React = require('react')
  const { act } = require('react-dom/test-utils')
  const diagnostics = []
  const diagnosticConsole = { ...console, error: (...args) => diagnostics.push(args.map(String).join(' ')) }
  const renderer = loadShippedRenderer(React, diagnosticConsole)
  const hostCtx = effectContext('synthetic-shell')
  const pluginCtx = effectContext('dsh-split')
  const geometry = geometryDouble()
  const plugin = await compilePlugin(React, geometry, sourceDirectory, diagnosticConsole)
  const panelInfo = observable({ activePanelId: null })
  const summaries = observable({ byId: {} })
  const records = new Map()
  const counts = { retainAttempts: [], retained: [], released: [], mounted: [], unmounted: [], navigated: [], renderAreas: [] }
  const failures = []
  const emptyBinding = { key: undefined, ctx: {}, hooks: {}, keyedHooks: {}, props: {} }
  const current = observable(emptyBinding)
  const bindingSources = new Map()
  let mountedRoot

  const addSession = (id, session, conversation = { activeTargets: new Set() }, summary = {}) => {
    const sessionSource = observable({ blank: false, awaitingFirstTurn: false, running: false, openState: 'open', ...session })
    const conversationSource = observable(conversation)
    const binding = { key: id, ctx: effectContext(id), hooks: { session: sessionSource, conversation: conversationSource }, keyedHooks: {}, props: { sessionId: id } }
    const record = { id, session: sessionSource, conversation: conversationSource, binding }
    records.set(id, record)
    bindingSources.set(id, observable(binding))
    summaries.set({ byId: { ...summaries.getSnapshot().byId, [id]: { title: `Session ${id}`, blank: false, ...summary } } })
    return record
  }
  addSession('A', { blank: false })
  addSession('B', { blank: true, awaitingFirstTurn: true, openState: 'loading' })
  addSession('C', { blank: true, awaitingFirstTurn: true }, undefined, { blank: true })
  current.set(records.get('A').binding)
  if (withheldSessions.length > 0) summaries.set({ byId: Object.fromEntries(
    Object.entries(summaries.getSnapshot().byId).filter(([id]) => !withheldSessions.includes(id)),
  ) })
  if (restoreSessions.length > 0) window.localStorage.setItem('dsh.split.workbench.v1', JSON.stringify({
    schemaVersion: 1, focusedId: `restored-${restoreSessions[0]}`,
    panels: restoreSessions.map((sessionId) => ({ id: `restored-${sessionId}`, sessionId })),
  }))

  hostCtx.reflect.provide = (name, service) => { hostCtx[name] = service }
  renderer.apply(hostCtx)
  const registry = hostCtx.slots
  const adapter = {
    current,
    bindingSource(reference) {
      if (reference === undefined) return current
      const source = bindingSources.get(reference.sessionId)
      if (!source) throw new Error(`unretained synthetic session: ${reference.sessionId}`)
      return source
    },
    renderArea(binding, props) {
      counts.renderAreas.push(binding.key)
      return React.createElement('div', { 'data-test-session-area': binding.key }, props.children)
    },
  }
  registry.provideRoot({ hooks: { sessions: summaries } })
  registry.installScope('session', adapter)
  registry.installLocale({ getSnapshot: () => ({ revision: 0 }), subscribe: () => () => {}, bind: () => (key) => key })
  registry.onEntryError((...args) => failures.push(args))

  function Shell(props) {
    const panel = React.useSyncExternalStore(panelInfo.subscribe, panelInfo.getSnapshot)
    return props.renderSlot('main', {}, { entryKey: panel.activePanelId })
  }
  registry.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.workspaces.session.menu.item': { kind: 'list', scope: 'root' },
  } }, Shell)

  function ConversationProbe(props) {
    const session = props.useSession((state) => state)
    const conversation = props.useConversation((state) => state)
    React.useEffect(() => {
      counts.mounted.push(props.sessionId)
      return () => counts.unmounted.push(props.sessionId)
    }, [])
    if (conversation.crash) throw new Error(`synthetic conversation failure: ${props.sessionId}`)
    return React.createElement('section', {
      'data-test-conversation': props.sessionId,
      'data-test-phase': props.phase,
      'data-test-hero': String(props.hero),
      'data-test-variant': props.variant,
      'data-test-open-state': session.openState,
    }, React.createElement('textarea', { 'aria-label': `Compose ${props.sessionId}`, defaultValue: '' }))
  }
  registry.registerFactory({ name: 'conversation.content', scope: 'session' }, ConversationProbe)

  // Cordis normally supplies a caller-context proxy. Preserve that ownership axis
  // while sharing the real registry and declaration ledger with the host.
  pluginCtx.slots = Object.create(registry)
  pluginCtx.slots.ctx = pluginCtx
  pluginCtx.sessions = { retain(id) {
    counts.retainAttempts.push(id)
    if (!records.has(id) || !summaries.getSnapshot().byId[id]) throw new Error(`unknown synthetic session ${id}`)
    counts.retained.push(id)
    let released = false
    return { sessionId: id, release() {
      if (released) throw new Error(`reference ${id} released twice`)
      released = true
      counts.released.push(id)
    } }
  } }
  pluginCtx.layout = { panelInfo, selectPanel: (activePanelId) => panelInfo.set({ activePanelId }) }
  pluginCtx.uiSession = { adapter }
  pluginCtx.uiWorkspace = { openSession(id) { counts.navigated.push(id); current.set(records.get(id).binding) } }
  pluginCtx.sidebarRight = { isExpanded: () => true }
  pluginCtx.locale = { register: () => () => {} }
  plugin.apply(pluginCtx)

  const mainEntry = registry.entries('main').find((entry) => entry.options.key === 'dsh-split-workbench')
  const menu = (id) => registry.entries('sidebar.workspaces.session.menu.item').find((entry) => entry.options.id === id)
  const flush = async (fn = () => {}) => { await act(async () => { await fn(); await Promise.resolve() }) }
  const mount = async () => { await flush(() => { mountedRoot = hostCtx.uiRenderer.mount(document.querySelector('#test-root')) }) }
  const unmount = async () => { if (mountedRoot) { await flush(mountedRoot); mountedRoot = undefined } }
  const unload = async () => { await flush(() => pluginCtx.dispose()) }
  const close = async () => {
    await unmount()
    await flush(() => { pluginCtx.dispose(); hostCtx.dispose() })
    dom.window.close()
  }
  return {
    React, dom, renderer, registry, mainEntry, pluginCtx, hostCtx, menu, records, current, summaries,
    counts, failures, diagnostics, geometry, adapter, panelInfo, addSession, flush, mount, unmount, unload, close,
    conversation: (id) => document.querySelector(`[data-test-conversation="${id}"]`),
    pane: (id) => [...document.querySelectorAll('[data-dsh-split-surface]')].find((element) => element.querySelector(`[data-dsh-sidebar-host="${id}"]`)),
  }
}

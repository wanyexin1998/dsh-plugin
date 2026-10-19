#!/usr/bin/env node
/**
 * Offline lifecycle regression for the real rc.2 SidebarSessionView(s) classes
 * and their actual apply() effect. Run after generating a candidate patch tree:
 *   node tests/sidebar-retention.test.mjs --patch-root dist/host-patches-fix
 * Reproduce the old bug without changing installed files:
 *   node tests/sidebar-retention.test.mjs --patch-root docs/evidence/bugfix-20261016/before-host-fixes/patched
 * For isolated development only, --apply-edits applies the follow-on edits
 * in memory to a previous patched file (never writes that file). The diagnostic
 * --without-portal-key flag removes only P-2o in memory to isolate that regression.
 *
 * The synchronous snapshot-source contract is checked against the installed
 * ASAR. Snapshot storage/session allocator/current selection are synthetic.
 * Real React portals are tested separately. No live application/session is used.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { sidebarRetentionEdits } from '../tools/patches/sidebar-retention.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootIndex = process.argv.indexOf('--patch-root')
const patchRoot = path.resolve(root, rootIndex === -1 ? 'dist/host-patches-fix' : process.argv[rootIndex + 1])
const file = path.join(patchRoot, 'dsh-client-ui-sidebar-right/lib/client.js')
const ASAR = process.env.DSH_ASAR ?? 'E:/deepseek-harness/resources/app.asar'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

function readPackedEntry(name) {
  const fd = fs.openSync(ASAR, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const json = Buffer.alloc(head.readUInt32LE(12))
    fs.readSync(fd, json, 0, json.length, 16)
    let entry = JSON.parse(json.toString('utf8'))
    for (const part of name.split('/').filter(Boolean)) entry = entry?.files?.[part]
    assert.ok(entry?.offset !== undefined && !entry.unpacked, `packed entry ${name} must exist`)
    const body = Buffer.alloc(entry.size)
    fs.readSync(fd, body, 0, body.length, 8 + head.readUInt32LE(4) + Number(entry.offset))
    return body
  } finally { fs.closeSync(fd) }
}

const storePath = '/dsh/node_modules/@deepseek-ai/dsh-client-store/lib/index.js'
const sessionPath = '/dsh/node_modules/@deepseek-ai/dsh-client-ui-session/lib/client.js'
const storeBytes = readPackedEntry(storePath)
const sessionBytes = readPackedEntry(sessionPath)
const sessionSource = sessionBytes.toString('utf8')
assert.ok(sessionSource.includes('sessions.list.subscribe('), 'verify the installed catalog subscription contract')
assert.ok(sessionSource.includes('this.sessions.list.getSnapshot().byId'), 'verify the installed catalog snapshot contract')
const storeSource = storeBytes.toString('utf8')
assert.ok(storeSource.includes("Flush default is 'sync'"), 'verify synchronous default snapshot notifications')
const notifyStart = storeSource.indexOf('function notifySubscribers(')
const notifyEnd = storeSource.indexOf('/**', notifyStart)
const notifySubscribers = new Function(storeSource.slice(notifyStart, notifyEnd) + '\nreturn notifySubscribers;')()
const snapshotContract = { createSnapshotStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    set(next) { if (Object.is(value, next)) return; value = next; notifySubscribers(listeners, '[sidebar test source]') },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
} }
const inputSource = fs.readFileSync(file, 'utf8')
let source = inputSource
if (process.argv.includes('--apply-edits')) {
  for (const edit of sidebarRetentionEdits) {
    assert.equal(source.split(edit.find).length - 1, 1, `${edit.id} must have exactly one anchor`)
    source = source.replace(edit.find, edit.replace)
  }
}
if (process.argv.includes('--without-portal-key')) {
  const keyed = '(0, react_dom.createPortal)(face, host, view.sessionId)'
  assert.equal(source.split(keyed).length - 1, 1)
  source = source.replace(keyed, '(0, react_dom.createPortal)(face, host)')
}
const classesStart = source.indexOf('\t\t//#region lib/types/client/session-view.js')
const classesEnd = source.indexOf('\t\t//#region ../../util/crypto/src/index.ts', classesStart)
const effectStart = source.indexOf('\t\t\tconst views = new SidebarSessionViews(ctx.sessions);')
const effectEnd = source.indexOf('\t\t\tconst layout = ctx.layout;', effectStart)
assert.ok(classesStart >= 0 && classesEnd > classesStart && effectStart >= 0 && effectEnd > effectStart, 'exact shipped class/effect seams must remain identifiable')
console.log('sidebar retention evidence:', JSON.stringify({
  file, inputSha256: hash(inputSource), executedSha256: hash(source),
  classSourceLine: source.slice(0, classesStart).split('\n').length,
  effectSourceLine: source.slice(0, effectStart).split('\n').length,
  store: { asar: ASAR, entry: storePath, sha256: hash(storeBytes) },
  catalogContract: { entry: sessionPath, sha256: hash(sessionBytes) },
  inMemoryEdits: process.argv.includes('--apply-edits'),
  portalKeyRemoved: process.argv.includes('--without-portal-key'),
}))

function trackedStore(initial) {
  const source = snapshotContract.createSnapshotStore(initial)
  let active = 0
  return {
    ...source,
    subscribe(fn) {
      active += 1
      const stop = source.subscribe(fn)
      let stopped = false
      return () => { if (stopped) return; stopped = true; active -= 1; stop() }
    },
    get subscriberCount() { return active },
  }
}

function setup(t, { catalog = ['A', 'B'], selected = 'B', hosts = ['A', 'B'], marker = true, failRetain = new Set(), autoCleanup = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://sidebar-contract.invalid/' })
  const document = dom.window.document
  if (marker) document.documentElement.setAttribute('data-dsh-plugin-main-host', '')
  const hostElements = new Map()
  const setHosts = (ids, announce = true) => {
    for (const [id, element] of hostElements) if (!ids.includes(id)) { element.remove(); hostElements.delete(id) }
    for (const id of ids) if (!hostElements.has(id)) {
      const element = document.createElement('div')
      element.setAttribute('data-dsh-sidebar-host', id)
      document.body.appendChild(element)
      hostElements.set(id, element)
    }
    if (announce) announceHosts()
  }
  const announceHosts = () => document.dispatchEvent(new dom.window.CustomEvent('dsh-sidebar-host-change'))
  setHosts(hosts, false)
  const list = trackedStore({ byId: Object.fromEntries(catalog.map((id) => [id, { id, title: id }])) })
  const current = trackedStore({ key: selected })
  const retains = []
  const releases = []
  const diagnostics = []
  let nestedNotificationCount = 0
  const sessions = {
    list,
    retain(id, options) {
      assert.equal(options.source, 'sidebarView')
      if (!list.getSnapshot().byId[id]) throw new Error(`unknown synthetic session ${id}`)
      if (failRetain.has(id)) throw new Error(`synthetic retain failure ${id}`)
      if (retains.length > 30) throw new Error('runaway reentrant retain loop')
      const reference = { sessionId: id, ready: Promise.resolve() }
      retains.push(reference)
      let released = false
      reference.release = () => {
        assert.equal(released, false, `reference ${id} must be released once`)
        released = true
        releases.push(reference)
        // The real SessionPool republishes retention into its list. Exercise
        // those synchronous callbacks before the owner finishes this mutation.
        nestedNotificationCount += 1
        list.set({ ...list.getSnapshot() })
      }
      nestedNotificationCount += 1
      list.set({ ...list.getSnapshot() })
      return reference
    },
  }
  const cleanup = []
  const ctx = {
    sessions, uiSession: { adapter: { current } },
    effect(fn) { const dispose = fn(); cleanup.push(dispose); return dispose },
  }
  const load = new Function('_deepseek_ai_dsh_client_store', 'document', 'console',
    source.slice(classesStart, classesEnd) + '\nreturn function install(ctx) {\n' + source.slice(effectStart, effectEnd) + '\nreturn views;\n};')
  const install = load(snapshotContract, document, { error: (...args) => diagnostics.push(args.map(String).join(' ')) })
  const views = install(ctx)
  let stopped = false
  const dispose = () => {
    if (stopped) return
    stopped = true
    for (const stop of [...cleanup].reverse()) stop()
  }
  if (autoCleanup) t.after(() => { dispose(); dom.window.close() })
  const snapshot = () => views.source.getSnapshot()
  const ids = () => snapshot().map((view) => view.sessionId)
  const find = (id) => {
    const view = snapshot().find((view) => view.sessionId === id)
    assert.ok(view, `${id} must have a Sidebar View`)
    return view
  }
  return { views, snapshot, ids, find, list, current, retains, releases, diagnostics, dom, document, hostElements, setHosts, announceHosts, dispose,
    get nestedNotificationCount() { return nestedNotificationCount },
  }
}

test('all hosted sessions create Sidebar Views and focus/collapse keep their references', (t) => {
  const h = setup(t)
  assert.deepEqual(h.ids(), ['A', 'B'])
  const a = h.find('A').reference
  const b = h.find('B').reference
  assert.equal(h.find('B').selected, true)
  h.current.set({ key: 'A' })
  assert.equal(h.find('A').selected, true)
  assert.equal(h.find('B').selected, false)
  h.current.set({ key: 'B' })
  h.hostElements.get('A').style.display = 'none'
  h.hostElements.get('A').setAttribute('data-dsh-sidebar-collapsed', 'true')
  h.announceHosts()
  assert.equal(h.find('A').reference, a)
  assert.equal(h.find('B').reference, b)
  assert.equal(h.retains.length, 2, 'focus and collapse must not re-retain')
  assert.equal(h.releases.length, 0)
  assert.deepEqual(h.diagnostics, [])
})

test('closing a hosted pane retires only it and waits for its committed root to unmount', (t) => {
  const h = setup(t)
  const a = h.find('A').reference
  const b = h.find('B').reference
  const unmountA = h.views.mount(a)
  h.setHosts(['B'])
  assert.deepEqual(h.ids(), ['B'])
  assert.equal(h.releases.length, 0, 'mounted A must retain until its React cleanup')
  unmountA()
  assert.deepEqual(h.releases, [a])
  assert.equal(h.find('B').reference, b)
  assert.equal(h.retains.length, 2)
})

test('native keepMounted tab holds survive pane closure until their final cancellation', (t) => {
  const h = setup(t)
  const a = h.find('A')
  const unmountA = h.views.mount(a.reference)
  const first = new AbortController()
  const second = new AbortController()
  const releaseFirst = a.retainTab('tab-a', first.signal)
  a.retainTab('tab-a', second.signal)
  h.setHosts(['B'])
  assert.deepEqual(h.ids(), ['A', 'B'], 'native tab lifetime remains an independent hold')
  first.abort()
  releaseFirst()
  assert.deepEqual(h.ids(), ['A', 'B'], 'duplicate release cannot cancel the second hold')
  second.abort()
  assert.deepEqual(h.ids(), ['B'])
  assert.equal(h.releases.length, 0)
  unmountA()
  assert.deepEqual(h.releases, [a.reference])
})

test('leaving split mode restores foreground-only ownership; unload removes listeners and releases views', (t) => {
  const h = setup(t)
  const a = h.find('A').reference
  const b = h.find('B').reference
  h.document.documentElement.removeAttribute('data-dsh-plugin-main-host')
  h.announceHosts()
  assert.deepEqual(h.ids(), ['B'], 'stale DOM hosts must not hold sessions outside split mode')
  assert.deepEqual(h.releases, [a])
  assert.equal(h.find('B').reference, b)
  h.document.documentElement.setAttribute('data-dsh-plugin-main-host', '')
  h.announceHosts()
  assert.deepEqual(h.ids(), ['A', 'B'])
  assert.equal(h.find('B').reference, b)
  const mountedA = h.views.mount(h.find('A').reference)
  h.dispose()
  assert.deepEqual(h.ids(), [])
  assert.equal(h.releases.length, h.retains.length)
  assert.equal(h.list.subscriberCount, 0)
  assert.equal(h.current.subscriberCount, 0)
  const before = h.retains.length
  h.announceHosts()
  h.current.set({ key: 'A' })
  h.list.set({ ...h.list.getSnapshot() })
  mountedA()
  assert.equal(h.retains.length, before)
  assert.equal(new Set(h.releases).size, h.releases.length)
})

test('missing initial catalog entries recover on the verified sessions.list subscription', (t) => {
  const h = setup(t, { catalog: ['A'], selected: 'A' })
  assert.deepEqual(h.ids(), ['A'])
  const a = h.find('A').reference
  h.list.set({ byId: { A: { id: 'A' }, B: { id: 'B' } } })
  assert.deepEqual(h.ids(), ['A', 'B'])
  assert.equal(h.find('A').reference, a)
  const published = h.snapshot()
  h.list.set({ byId: { A: { id: 'A', title: 'renamed' }, B: { id: 'B' } } })
  assert.equal(h.snapshot(), published, 'title changes must not publish an equivalent View roster')
  assert.equal(h.retains.length, 2)
  assert.deepEqual(h.diagnostics, [])
})

test('synchronous retain/release catalog callbacks cannot recursively create duplicate Views', (t) => {
  const h = setup(t)
  assert.ok(h.nestedNotificationCount >= 2)
  assert.deepEqual(h.ids(), ['A', 'B'])
  assert.equal(h.retains.length, 2)
  let notifications = 0
  const stop = h.views.source.subscribe(() => {
    notifications += 1
    if (notifications > 4) throw new Error('recursive view publication')
    h.announceHosts()
  })
  h.current.set({ key: 'A' })
  h.setHosts(['A'])
  stop()
  assert.deepEqual(h.ids(), ['A'])
  assert.equal(h.retains.length, 2)
  assert.equal(h.releases.length, 1)
  assert.equal(h.releases[0].sessionId, 'B')
  assert.ok(notifications <= 2)
})

test('a temporary hosted retain failure is bounded and retries on the next catalog event', (t) => {
  const failures = new Set(['B'])
  const h = setup(t, { failRetain: failures })
  assert.deepEqual(h.ids(), ['A'])
  assert.equal(h.diagnostics.length, 1, 'one reconciliation may attempt the failed reference only once')
  assert.match(h.diagnostics[0], /synthetic retain failure B/)
  const a = h.find('A').reference
  failures.delete('B')
  h.list.set({ ...h.list.getSnapshot() })
  assert.deepEqual(h.ids(), ['A', 'B'])
  assert.equal(h.find('A').reference, a)
  assert.equal(h.retains.length, 2)
})

test('real keyed React portals preserve Sidebar draft DOM when A/B insert or close before C', async (t) => {
  const h = setup(t, { catalog: ['A', 'B', 'C'], selected: 'C', hosts: ['C'], autoCleanup: false })
  const globalKeys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']
  const descriptors = Object.fromEntries(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const key of globalKeys) Object.defineProperty(globalThis, key, {
    value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'window' ? h.dom.window : h.dom.window[key], configurable: true, writable: true,
  })
  const require = createRequire(import.meta.url)
  const React = require('react')
  const ReactDOM = require('react-dom')
  const { createRoot } = require('react-dom/client')
  const { act } = require('react-dom/test-utils')
  const jsx = require('react/jsx-runtime')
  const shellStart = source.indexOf('\t\tfunction SessionView(')
  assert.ok(shellStart >= 0 && shellStart < classesStart)
  const { RightbarRoot } = new Function('react', 'react_dom', 'react_jsx_runtime', 'SidebarRight_module_css_default', 'document', 'window', 'CSS',
    source.slice(shellStart, classesStart) + '\nreturn { RightbarRoot };')(React, ReactDOM, jsx, { session: 'synthetic-sidebar-session' }, h.document, h.dom.window, { escape: (id) => id })
  const selectedReference = React.createContext(null)
  const mounts = []
  const unmounts = []
  function SessionProvider({ session, children }) {
    return React.createElement(selectedReference.Provider, { value: session }, children)
  }
  function SidebarBody() {
    const reference = React.useContext(selectedReference)
    React.useEffect(() => {
      mounts.push(reference.sessionId)
      return () => unmounts.push(reference.sessionId)
    }, [reference])
    return React.createElement('textarea', { 'data-sidebar-draft': reference.sessionId, defaultValue: '' })
  }
  const props = {
    usePanelInfo: (select) => select({ activePanelId: 'dsh-split-workbench' }),
    useViews: (select) => select(React.useSyncExternalStore(h.views.source.subscribe, h.views.source.getSnapshot)),
    mountView: h.views.mount.bind(h.views), SessionProvider,
    renderSlot: (name) => { assert.equal(name, 'rightbar.session'); return React.createElement(SidebarBody) },
    width: 320, viewportWidth: 1440, canShow: true,
  }
  const rootElement = h.document.createElement('div')
  h.document.body.appendChild(rootElement)
  const reactRoot = createRoot(rootElement)
  t.after(async () => {
    await act(async () => reactRoot.unmount())
    h.dispose()
    h.dom.window.close()
    for (const key of globalKeys) {
      if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key])
      else delete globalThis[key]
    }
  })
  await act(async () => reactRoot.render(React.createElement(RightbarRoot, props)))
  const c = h.document.querySelector('[data-sidebar-draft="C"]')
  assert.ok(c)
  c.value = 'C unsent sidebar draft'

  await act(async () => h.setHosts(['B', 'C']))
  const b = h.document.querySelector('[data-sidebar-draft="B"]')
  assert.ok(b)
  b.value = 'B unsent sidebar draft'
  assert.ok(h.document.querySelector('[data-sidebar-draft="C"]') === c, 'inserting B before C must preserve C portal identity')
  await act(async () => h.setHosts(['A', 'B', 'C']))
  assert.ok(h.document.querySelector('[data-sidebar-draft="B"]') === b)
  assert.ok(h.document.querySelector('[data-sidebar-draft="C"]') === c)
  assert.equal(b.value, 'B unsent sidebar draft')
  await act(async () => h.setHosts(['A', 'C']))
  assert.ok(h.document.querySelector('[data-sidebar-draft="C"]') === c, 'closing B must preserve C portal identity')
  await act(async () => h.setHosts(['C']))
  assert.ok(h.document.querySelector('[data-sidebar-draft="C"]') === c)
  assert.equal(c.value, 'C unsent sidebar draft')
  assert.equal(mounts.filter((id) => id === 'C').length, 1)
  assert.equal(mounts.filter((id) => id === 'B').length, 1)
  assert.deepEqual(unmounts, ['B', 'A'])
  assert.equal(h.retains.filter((ref) => ref.sessionId === 'C').length, 1)
  assert.deepEqual(h.diagnostics, [])
})

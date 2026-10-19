#!/usr/bin/env node
/**
 * Probe dry run (P0 tooling, offline).
 *
 * Runs the BUILT probe bundle (`probe/lib/client.js`) against a minimal host double
 * inside jsdom, so the code paths that will execute inside the user's app are
 * exercised before they ever touch that environment:
 *
 *   apply(ctx) → slot registrations → render the probe panel → click every action
 *   → collect the console evidence lines → feed them to tools/p0-report.mjs
 *
 * The host double mimics the contracts the probe relies on (slot registry with
 * `inject`, `ctx.effect`, a `panelInfo` store with a validating `selectPanel`, a
 * session list, `retain`/`retainInfo`, `uiWorkspace.openSession` including the real
 * `reveal → selectPanel(null)` behaviour, and a `sidebarRight` surface).
 *
 * Usage: node tools/probe-dry-run.mjs        (exit 0 = the pipeline works end to end)
 */
import { JSDOM } from 'jsdom'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dom = new JSDOM(
  '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  { pretendToBeVisual: true, url: 'http://localhost/' },
)
const { window } = dom
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Event: window.Event,
  CustomEvent: window.CustomEvent,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  DOMRect: window.DOMRect,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })

const require_ = createRequire(import.meta.url)
const React = require_('react')
const ReactDOM = require_('react-dom/client')

const results = []
const check = (name, ok, note) => {
  results.push({ name, ok: Boolean(ok) })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (note === undefined ? '' : ' — ' + String(note)))
}

const frames = (count) => new Promise((resolve) => {
  let left = count
  const step = () => {
    left -= 1
    if (left <= 0) resolve()
    else window.requestAnimationFrame(step)
  }
  window.requestAnimationFrame(step)
})

/* ------------------------------------------------------------- host double -- */

function storeOf(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

const registrations = []
const disposers = []
const eventLines = []
const originalLog = console.log
console.log = (...args) => {
  const line = args.map((value) => (typeof value === 'string' ? value : String(value))).join(' ')
  if (line.startsWith('[dsh-split-probe]')) eventLines.push(line)
  originalLog(...args)
}

const panelInfo = storeOf({ activePanelId: null })
const sessionList = storeOf({ ids: ['s1', 's2'], byId: { s1: { id: 's1' }, s2: { id: 's2' } } })
const currentSession = storeOf({ key: 's1' })
const releaseCount = { value: 0 }

let workbenchRoot = null
const ctx = {
  effect(fn, label) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push({ label, disposer })
    return () => {}
  },
  slots: {
    inject(name, factory) {
      const produced = factory()
      const items = produced !== null && typeof produced === 'object' && typeof produced[Symbol.iterator] === 'function'
        ? [...produced]
        : [produced]
      registrations.push({ name, items })
      return () => {}
    },
    register(spec, component) {
      return { spec, component }
    },
  },
  layout: {
    panelInfo,
    selectPanel(key) {
      if (key === null) {
        panelInfo.set({ activePanelId: null })
        if (workbenchRoot !== null) {
          workbenchRoot.unmount()
          workbenchRoot = null
        }
        return
      }
      const entry = registrations
        .flatMap((registration) => registration.items)
        .find((item) => item?.spec?.name === 'main' && item?.spec?.key === key)
      if (entry === undefined) throw new Error('unknown main panel key: ' + key)
      panelInfo.set({ activePanelId: key })
      // Render the plugin's main-key component so the mounted signal is real.
      const host = window.document.createElement('div')
      host.setAttribute('data-workbench-host', '')
      window.document.body.appendChild(host)
      workbenchRoot = ReactDOM.createRoot(host)
      const entryProps = typeof entry.spec.inject === 'function' ? entry.spec.inject() : {}
      workbenchRoot.render(React.createElement(entry.component, entryProps))
    },
  },
  sessions: {
    list: sessionList,
    retain(sessionId, options) {
      return { sessionId, options, release: () => { releaseCount.value += 1 } }
    },
    retainInfo(sessionId) {
      return storeOf({ retainedBy: { mainView: sessionId === 's1' ? 1 : 0 } })
    },
  },
  uiSession: { adapter: { current: currentSession } },
  uiWorkspace: {
    // Mirrors the shipped behaviour that P-1 must change: reveal navigation drops
    // the panel selection back to the conversation surface.
    openSession(sessionId) {
      currentSession.set({ key: sessionId })
      if (panelInfo.getSnapshot().activePanelId !== null) panelInfo.set({ activePanelId: null })
    },
  },
  sidebarRight: { isExpanded: () => true, mounted: storeOf('s1') },
}

/* -------------------------------------------------------------- run it -- */

// The bundle registers itself with the client-module loader (`window.__ModuleLoader__
// .load({ id, factory })`), which is where `require`/`module`/`exports` come from —
// mirror that entry point here, and fail loudly if the wrapper is missing (that
// missing wrapper is exactly what broke the desktop web boot on 2026-10-15).
const bundlePath = new URL('../lib/client.js', import.meta.url)
const bundleCode = readFileSync(bundlePath, 'utf8')
let loaderRecord = null
globalThis.window.__ModuleLoader__ = {
  load(record) {
    loaderRecord = record
  },
}
{
  const shell = { exports: {} }
  const evaluate = new Function('window', 'require', 'module', 'exports', '__filename', '__dirname', bundleCode)
  evaluate(window, require_, shell, shell.exports, fileURLToPath(bundlePath), dirname(fileURLToPath(bundlePath)))
}
check('the bundle registers itself with the module loader (factory wrapper present)',
  loaderRecord !== null && typeof loaderRecord.factory === 'function' && loaderRecord.id === 'dsh-split-probe',
  loaderRecord === null ? 'no __ModuleLoader__.load call — the browser would evaluate it as an ES module' : String(loaderRecord.id))
const probe = loaderRecord === null ? {} : loaderRecord.factory(require_)
check('the built probe exposes apply()', typeof probe.apply === 'function')

// Cordis refuses `ctx.<service>` unless the plugin declared it in `inject` — an omitted
// list fails ACTIVATION (and blocks web boot). Guard it: a Proxy that throws the exact
// shipped message for every undeclared service the probe might touch.
const SERVICE_NAMES = ['slots', 'sessions', 'layout', 'uiSession', 'uiWorkspace', 'sidebarRight', 'locale', 'shortcuts', 'fileUpload', 'attachments', 'uiConversation', 'sidebarRightTabs', 'conversation']
const declaredServices = new Set(Array.isArray(probe.inject) ? probe.inject : [])
check('declares the services it reads (inject)', declaredServices.has('slots') && declaredServices.has('sessions') && declaredServices.has('layout'),
  Array.isArray(probe.inject) ? probe.inject.join(',') : 'no inject export')
const strictContext = (base) => new Proxy(base, {
  get(target, property, receiver) {
    if (typeof property === 'string' && SERVICE_NAMES.includes(property) && !declaredServices.has(property)) {
      throw new Error('cannot get property "' + property + '" without inject')
    }
    return Reflect.get(target, property, receiver)
  },
})

probe.apply(strictContext(ctx))
check('two overlay/child slots were registered', registrations.length === 3, registrations.map((r) => r.name).join(','))
const overlay = registrations.find((entry) => entry.name === 'shell.overlay')
check('the probe panel registered on shell.overlay', overlay !== undefined && overlay.items.length === 1)
check('the workbench main key registered', registrations.some((entry) => entry.items.some((item) => item?.spec?.key === 'dsh-split-probe-workbench')))

const registration = overlay.items[0]
const spec = registration.spec
const PanelComponent = registration.component
check('the panel registration carries a component', typeof PanelComponent === 'function')
const injected = typeof spec.inject === 'function' ? spec.inject() : {}
const container = window.document.getElementById('root')
const root = ReactDOM.createRoot(container)
const StubProvider = (props) => React.createElement('div', { 'data-stub-provider': '' }, props.children)
root.render(React.createElement(PanelComponent, {
  ...injected,
  SessionProvider: StubProvider,
  renderFactorySlot: (name) => React.createElement('div', { 'data-stub-factory': name }, name),
}))
await frames(4)
check('the probe panel rendered', container.querySelector('[data-split-probe]') !== null)

// Buttons carry `disabled={busy}`; React clears that on the next render, so wait for
// an enabled button instead of clicking into a stale disabled state.
const clickButton = async (label, budget = 60) => {
  for (let i = 0; i < budget; i += 1) {
    const button = [...container.querySelectorAll('button')]
      .find((candidate) => (candidate.textContent ?? '').includes(label) && candidate.disabled === false)
    if (button !== undefined) {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      return true
    }
    await frames(1)
  }
  return false
}

const steps = [
  ['1 能力发现', 'W001/discovery'],
  ['2 切到自建主面板', 'W003-a/select-own-main-key'],
  ['3 挂第二份呈现', 'W003-b/mounted-copy'],
  ['输入框正常', 'W003-b/manual-typing'],
  ['4 卸下并还原', 'W003-b/second-presentation'],
  ['5 Sidebar 切换', 'W004/session-switch-sidebar'],
  ['6 Dockview 实测', 'W005/dockview-restricted'],
  ['7 销毁 Dockview', 'W005/disposed'],
]
const sawRow = (rowId) => eventLines.some((line) => line.includes(rowId))
const waitForRow = async (rowId, budget = 60) => {
  for (let i = 0; i < budget; i += 1) {
    if (sawRow(rowId)) return true
    await frames(1)
  }
  return sawRow(rowId)
}

for (const [label, expectedRow] of steps) {
  const clicked = await clickButton(label)
  check('clicked “' + label + '”', clicked)
  // Actions await several frames internally, so poll instead of guessing a count.
  const seen = await waitForRow(expectedRow)
  check('  → produced ' + expectedRow, seen)
}

check('every action restored the panel selection', panelInfo.getSnapshot().activePanelId === null, JSON.stringify(panelInfo.getSnapshot()))
check('the retained copy was released', releaseCount.value === 1, String(releaseCount.value))
check('the dockview instance was disposed', eventLines.some((line) => line.includes('W005/disposed')))

/* ------------------------------------------- feed the report to the evaluator -- */

const rows = eventLines
  .filter((line) => line.startsWith('[dsh-split-probe] ') && !line.startsWith('[dsh-split-probe] report'))
  .map((line) => {
    const rest = line.slice('[dsh-split-probe] '.length)
    const opened = rest.indexOf(' [')
    const closed = rest.indexOf('] ', opened)
    const id = rest.slice(0, opened)
    const status = rest.slice(opened + 2, closed)
    const detail = rest.slice(closed + 2)
    return { id, status, detail }
  })
const report = { probe: 'dsh-split-probe', at: 'dry-run', rows }
const dir = mkdtempSync(join(tmpdir(), 'p0-dry-'))
const reportPath = join(dir, 'dry-report.json')
writeFileSync(reportPath, JSON.stringify(report, null, 2))
check('the dry run produced a report', rows.length >= 10, rows.length + ' rows')

let evaluatorExit = 0
let evaluatorOut = ''
try {
  evaluatorOut = execFileSync(process.execPath, ['tools/p0-report.mjs', reportPath], { cwd: process.cwd(), encoding: 'utf8' })
} catch (error) {
  evaluatorExit = error.status ?? 2
  evaluatorOut = String(error.stdout ?? '') + String(error.stderr ?? '')
}
console.log('')
console.log(evaluatorOut.trim())
check('the evaluator accepted the dry-run report (exit 0)', evaluatorExit === 0, 'exit=' + evaluatorExit)

/* ----------------------------- phase 2: a host that rejects the panel registration -- */

// Regression guard for the 2026-10-15/16 boot failures: a rejected registration must not
// make activation throw, and when the React panel cannot mount at all the slot-free panel
// must take its place (single panel on screen — never both).
{
  // A fresh module instance: its `panelRendered` flag starts false, like a page load.
  const fresh = (() => {
    let record = null
    globalThis.window.__ModuleLoader__ = { load(value) { record = value } }
    const shell = { exports: {} }
    new Function('window', 'require', 'module', 'exports', '__filename', '__dirname', bundleCode)(
      window, require_, shell, shell.exports, fileURLToPath(bundlePath), dirname(fileURLToPath(bundlePath)),
    )
    return record === null ? null : record.factory(require_)
  })()
  check('a fresh module instance loads', fresh !== null && typeof fresh.apply === 'function')

  const rejectPanel = {
    effect(fn) {
      return fn() // let the rejection reach the probe's own guard
    },
    slots: {
      inject(name) {
        throw new Error('slot "' + name + '" is not declared')
      },
      register(spec, component) {
        return { spec, component }
      },
    },
    layout: { panelInfo: storeOf({ activePanelId: null }), selectPanel() {} },
    sessions: { list: storeOf({ ids: [], byId: {} }), retain: () => ({ release() {} }), retainInfo: () => storeOf({}) },
    uiSession: { adapter: { current: storeOf({ key: undefined }) } },
    uiWorkspace: { openSession() {} },
    sidebarRight: { isExpanded: () => false },
  }

  let threw = false
  try {
    fresh.apply(strictContext(rejectPanel))
  } catch (error) {
    threw = true
  }
  check('activation survives a fully rejected panel registration (never blocks web boot)', !threw)

  const deadline = Date.now() + 4000
  while (Date.now() < deadline && window.document.querySelector('[data-split-probe-fallback]') === null) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const fallback = window.document.querySelector('[data-split-probe-fallback]')
  check('the slot-free panel appears when the React panel cannot mount', fallback !== null)
  const text = fallback === null ? '' : fallback.textContent
  check('the panel names the rejected registration', text.includes('not declared'), text.slice(0, 140))
}
const failed = results.filter((row) => !row.ok)
console.log('')
console.log(failed.length === 0
  ? 'probe dry run: all ' + results.length + ' checks passed'
  : 'probe dry run: ' + failed.length + ' of ' + results.length + ' failed')
process.exit(failed.length === 0 ? 0 : 2)

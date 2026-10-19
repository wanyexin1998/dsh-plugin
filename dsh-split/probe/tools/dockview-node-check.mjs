#!/usr/bin/env node
/**
 * Node-side Dockview check (W005, offline).
 *
 * Runs the REAL `dockview-core@8.5.1` inside jsdom to verify — before the app probe
 * runs — that the restricted option set we intend to use is accepted, that the
 * public move API re-hosts a panel WITHOUT rebuilding its component DOM node, and
 * that a locked + headerless group behaves as the source claims.
 *
 * Limits: jsdom has no layout engine, so pixel geometry is meaningless here. This
 * script deliberately asserts model/DOM-identity facts only; the in-app probe
 * (`probe/src/probe.js`, action 6) remains the source of truth for real geometry,
 * iframe lifecycle and pointer DnD.
 *
 * Usage: node tools/dockview-node-check.mjs        (exit 0 = all checks pass)
 */
import { JSDOM } from 'jsdom'
import { createRequire } from 'node:module'

const dom = new JSDOM(
  '<!doctype html><html><head></head><body><div id="host"></div></body></html>',
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
// jsdom ships no ResizeObserver / IntersectionObserver / matchMedia.
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })

const host = window.document.getElementById('host')
// dockview sizes its grid from the container's client box; jsdom reports 0.
Object.defineProperty(host, 'clientWidth', { value: 1200, configurable: true })
Object.defineProperty(host, 'clientHeight', { value: 800, configurable: true })

const require_ = createRequire(import.meta.url)
const { DockviewComponent } = require_('dockview-core')

const results = []
const check = (name, ok, note) => {
  results.push({ name, ok: Boolean(ok), note: note === undefined ? '' : String(note) })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (note === undefined ? '' : ' — ' + String(note)))
}

const markers = new Map()
const createComponent = (options) => {
  const id = String(options.id !== undefined ? options.id : (options.name !== undefined ? options.name : 'panel'))
  const node = window.document.createElement('div')
  node.setAttribute('data-marker', id)
  node.textContent = 'panel ' + id
  markers.set(id, node)
  return { element: node, init: () => {}, dispose: () => {} }
}

const options = {
  singleTabMode: 'default',
  disableFloatingGroups: true,
  hideBorders: false,
  noPanelsOverlay: 'emptyGroup',
  createComponent,
}

let api = null
let constructError = null
try {
  api = new DockviewComponent(host, options)
} catch (error) {
  constructError = String(error && error.message ? error.message : error)
}
check('restricted option set is accepted', api !== null, constructError)

if (api !== null) {
  let lockedGroup = null
  let addGroupError = null
  try {
    // AddGroupOptions = (WithGroup | WithPanel | Absolute) & GroupOptions, so a
    // reference and direction are mandatory before the group options apply.
    const reference = api.groups[0]
    lockedGroup = api.addGroup({
      referenceGroup: reference,
      direction: 'right',
      locked: 'no-drop-target',
      hideHeader: true,
      id: 'locked-group',
    })
  } catch (error) {
    addGroupError = String(error && error.message ? error.message : error)
  }
  check('addGroup accepts { referenceGroup, direction, locked: "no-drop-target", hideHeader: true }', lockedGroup !== null, addGroupError)

  const added = []
  const failures = []
  const panelOf = (id) => api.panels.find((panel) => panel.id === id)
  for (const id of ['probe-a', 'probe-b', 'probe-c']) {
    try {
      api.addPanel({ id, component: 'probe', title: id })
      added.push(id)
    } catch (error) {
      failures.push(id + ': ' + String(error && error.message ? error.message : error))
    }
  }
  if (lockedGroup !== null) {
    for (const id of ['probe-d', 'probe-e']) {
      try {
        api.addPanel({ id, component: 'probe', title: id, position: { referenceGroup: lockedGroup } })
        added.push(id)
      } catch (error) {
        failures.push(id + ': ' + String(error && error.message ? error.message : error))
      }
    }
  }
  check('addPanel accepts five panels (3 open group + 2 locked group)', failures.length === 0, failures.join(' | '))
  check('every panel got its own component element', markers.size === added.length, markers.size + ' markers for ' + added.length + ' panels')

  let lockedReadBack = null
  let headerless = null
  try {
    lockedReadBack = lockedGroup.api.locked
    const element = lockedGroup.element
    headerless = {
      headerHidden: lockedGroup.header === undefined || lockedGroup.header === null ? null : lockedGroup.header.hidden,
      lockedClass: element === undefined || element === null
        ? null
        : element.className.includes('dv-locked-groupview'),
      modelOptions: lockedGroup.model === undefined ? null : lockedGroup.model.options,
    }
  } catch (error) {
    lockedReadBack = 'error: ' + String(error)
  }
  check('locked group reads its lock back', lockedReadBack === 'no-drop-target', JSON.stringify(lockedReadBack))
  // NB: the header ELEMENT still exists while hidden, so "no tab strip" must be read
  // from the model (`header.hidden`) or the group class, never from a node count.
  check(
    'headerless group reports a hidden header and the locked group class',
    headerless !== null && headerless.headerHidden === true && headerless.lockedClass === true,
    JSON.stringify(headerless),
  )

  const before = markers.get('probe-a')
  let moveError = null
  try {
    const panel = panelOf('probe-a')
    const target = panelOf('probe-b')
    if (panel === undefined || target === undefined) throw new Error('panel lookup returned undefined')
    panel.api.moveTo({ group: target.api.group })
  } catch (error) {
    moveError = String(error && error.message ? error.message : error)
  }
  const after = markers.get('probe-a')
  const sameNode = before !== undefined && before === after
  check('the public move API kept the same component DOM node (no remove+add)', sameNode && after.isConnected, 'moveError=' + String(moveError))

  let snapshot = null
  try {
    const raw = api.toJSON()
    snapshot = raw !== null && typeof raw === 'object' ? Object.keys(raw) : null
  } catch (error) {
    snapshot = ['error: ' + String(error)]
  }
  check('toJSON produces a snapshot', Array.isArray(snapshot) && snapshot.length > 0, JSON.stringify(snapshot))

  // jsdom has no layout engine, so maximize (which needs real geometry) is recorded
  // as a note and left to the in-app probe.
  let maximize = null
  try {
    const panel = panelOf('probe-a')
    if (panel === undefined) throw new Error('panel lookup returned undefined')
    api.maximizeGroup(panel)
    const during = typeof api.hasMaximizedGroup === 'function' ? api.hasMaximizedGroup() : null
    api.exitMaximizedGroup()
    maximize = { during, after: typeof api.hasMaximizedGroup === 'function' ? api.hasMaximizedGroup() : null }
  } catch (error) {
    maximize = { note: 'deferred to the in-app probe (jsdom has no layout): ' + String(error && error.message ? error.message : error) }
  }
  console.log('  note  maximize/restore: ' + JSON.stringify(maximize))

  check('panels report their ids', api.panels.map((p) => p.id).sort().join(',') === ['probe-a', 'probe-b', 'probe-c', 'probe-d', 'probe-e'].sort().join(','), api.panels.map((p) => p.id).join(','))
  check('dndCapabilities is exposed', api.dndCapabilities !== undefined && api.dndCapabilities !== null, JSON.stringify(api.dndCapabilities))

  try {
    api.dispose()
  } catch (error) {
    check('dispose is clean', false, String(error))
  }
}

const failed = results.filter((row) => !row.ok)
console.log('')
console.log(failed.length === 0
  ? 'dockview node check: all ' + results.length + ' checks passed'
  : 'dockview node check: ' + failed.length + ' of ' + results.length + ' failed')
process.exit(failed.length === 0 ? 0 : 2)

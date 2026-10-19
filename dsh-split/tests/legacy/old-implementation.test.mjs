/**
 * LEGACY SUITE — retired with the old implementation (v5 plan §09: "旧测试中保护用户行为的
 * 可以转写；验证 generation、双 bump 或覆盖层补偿的测试退役").
 *
 * This suite drove the pre-swap `lib/client.js` (overlay + generation hand-off + binary tree).
 * After the workbench swap `lib/` holds the new artifact, so the suite no longer describes
 * the running plugin. Kept as a historical asset and as the reference for behaviours that
 * were transferred to `tests/layout.test.mjs` (place/duplicate/close/cycle/serialize).
 *
 * To run it against the retired artifact: restore `lib.bak-install-<stamp>` over `lib/` first.
 *//**
 * Bundle smoke test for dsh-split.
 *
 * Loads `lib/client.js` the way the shell does (a `window.__ModuleLoader__.load`
 * registration whose factory receives `require`), then runs `apply` against a
 * recording fake context. This is the pre-restart gate: it catches a malformed
 * registration, a misspelled slot, a wrong inject shape, and every layout,
 * reference, overlay, and panel-remount bug in the controller — none of which the
 * browser would report anywhere except a page-local failure banner.
 *
 * Run: node tests/unit-bundle.mjs
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
}

/* ---------------------------------------------------------------- *
 * Shell surface
 * ---------------------------------------------------------------- */

const storage = new Map()
let writeCount = 0
const registrations = []
const frames = []
const timers = []
const pendingEffects = []
let frameSeq = 0
let timerSeq = 0

/**
 * The window's listener ledger.
 *
 * Every registration is recorded under the exact handler identity it was added
 * with, so a `removeEventListener` that never runs — a component whose cleanup
 * is missing, or a drag that outlives its pane — is a count mismatch here
 * instead of an invisible leak that only a browser's memory profiler would show.
 */
const windowLedger = { added: new Map(), removed: new Map(), live: new Map() }

function ledgerAdd(type, handler) {
  windowLedger.added.set(type, (windowLedger.added.get(type) ?? 0) + 1)
  const handlers = windowLedger.live.get(type) ?? new Map()
  handlers.set(handler, (handlers.get(handler) ?? 0) + 1)
  windowLedger.live.set(type, handlers)
}

function ledgerRemove(type, handler) {
  windowLedger.removed.set(type, (windowLedger.removed.get(type) ?? 0) + 1)
  const handlers = windowLedger.live.get(type)
  if (handlers === undefined) return
  const count = handlers.get(handler) ?? 0
  if (count <= 1) handlers.delete(handler)
  else handlers.set(handler, count - 1)
}

/** Live window handlers of one event type. */
function liveWindowListeners(type) {
  const handlers = windowLedger.live.get(type)
  if (handlers === undefined) return 0
  let total = 0
  for (const count of handlers.values()) total += count
  return total
}

/** Event types where an add has no matching remove. */
function unbalancedWindowTypes() {
  const types = new Set([...windowLedger.added.keys(), ...windowLedger.removed.keys()])
  const bad = []
  for (const type of types) {
    const added = windowLedger.added.get(type) ?? 0
    const removed = windowLedger.removed.get(type) ?? 0
    if (added !== removed) bad.push(type + ' ' + added + '/' + removed)
  }
  return bad
}

/** Deliver one event to the window handlers, the way the browser would. */
function dispatchWindow(type, event) {
  const handlers = windowLedger.live.get(type)
  if (handlers === undefined) return
  for (const handler of Array.from(handlers.keys())) handler(event)
}

/** One DOM event object, carrying the members the plugin reads. */
function domEvent(type, init) {
  const event = {
    type,
    target: null,
    currentTarget: null,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { event.defaultPrevented = true },
    stopPropagation() { event.stopped = true },
  }
  return Object.assign(event, init ?? {})
}

globalThis.window = {
  __ModuleLoader__: { load: (registration) => { registrations.push(registration) } },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { writeCount += 1; storage.set(key, String(value)) },
    removeItem: (key) => { storage.delete(key) },
  },
  requestAnimationFrame: (callback) => { frameSeq += 1; frames.push({ id: frameSeq, callback }); return frameSeq },
  cancelAnimationFrame: (id) => {
    const at = frames.findIndex((frame) => frame.id === id)
    if (at !== -1) frames.splice(at, 1)
  },
  setTimeout: (callback, delay) => { timerSeq += 1; timers.push({ id: timerSeq, callback, delay, cancelled: false }); return timerSeq },
  clearTimeout: (id) => {
    for (const entry of timers) if (entry.id === id) entry.cancelled = true
  },
  addEventListener: (type, handler) => { ledgerAdd(type, handler) },
  removeEventListener: (type, handler) => { ledgerRemove(type, handler) },
}
/* ---------------------------------------------------------------- *
 * Fake DOM
 *
 * Enough of the browser for the plugin's real effects to run: attributes that
 * notify a MutationObserver, a class list, a style object, listeners that can be
 * dispatched with capture and bubble, a queryable subtree, boxes, and pointer
 * capture. It is deliberately small — only what `lib/client.js` touches.
 * ---------------------------------------------------------------- */

/** One style declaration block; assignment is enough, `cssText` is for debugging. */
function createStyleObject() {
  const style = {}
  Object.defineProperty(style, 'setProperty', { value: (name, value) => { style[name] = String(value) } })
  Object.defineProperty(style, 'removeProperty', { value: (name) => { delete style[name] } })
  Object.defineProperty(style, 'getPropertyValue', { value: (name) => (style[name] === undefined ? '' : String(style[name])) })
  Object.defineProperty(style, 'cssText', {
    get: () => Object.keys(style).map((key) => key + ': ' + style[key]).join('; '),
  })
  return style
}

/** One compound selector: `tag`, `.class`, `#id`, `[attr]`, `[attr="value"]`, combined. */
function selectorMatcher(selector) {
  const text = String(selector).trim()
  const tagMatch = /^[a-zA-Z][\w:-]*/.exec(text)
  const tag = tagMatch === null ? null : tagMatch[0]
  const rest = tag === null ? text : text.slice(tag.length)
  const conditions = []
  const pattern = /\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g
  let match
  while ((match = pattern.exec(rest)) !== null) {
    if (match[1] !== undefined) {
      const className = match[1]
      conditions.push((element) => classListOf(element).contains(className))
    } else if (match[2] !== undefined) {
      const id = match[2]
      conditions.push((element) => element.getAttribute('id') === id)
    } else {
      const name = match[3]
      const value = match[4] ?? match[5] ?? match[6]
      conditions.push(value === undefined
        ? (element) => element.hasAttribute(name)
        : (element) => element.getAttribute(name) === value)
    }
  }
  return (element) => {
    if (element === null || element === undefined || element.nodeType !== 1) return false
    if (tag !== null && element.tag !== tag) return false
    return conditions.every((test) => test(element))
  }
}

/** The `classList` view of one element's `class` attribute. */
function classListOf(element) {
  const read = () => (element.getAttribute('class') ?? '').split(/\s+/).filter((name) => name !== '')
  const write = (names) => {
    if (names.length === 0) element.removeAttribute('class')
    else element.setAttribute('class', names.join(' '))
  }
  return {
    contains: (name) => read().indexOf(name) !== -1,
    add: (...names) => { const list = read(); for (const name of names) if (list.indexOf(name) === -1) list.push(name); write(list) },
    remove: (...names) => write(read().filter((name) => names.indexOf(name) === -1)),
    toggle: (name, force) => {
      const has = read().indexOf(name) !== -1
      const want = force === undefined ? !has : force === true
      if (want === has) return want
      if (want) write(read().concat([name]))
      else write(read().filter((item) => item !== name))
      return want
    },
    toString: () => read().join(' '),
  }
}

/** Every descendant element matching one selector, in document order. */
function queryAll(root, selector, firstOnly) {
  const matches = selectorMatcher(selector)
  const found = []
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue
      if (matches(child)) {
        found.push(child)
        if (firstOnly) return true
      }
      if (visit(child) === true) return true
    }
    return false
  }
  visit(root)
  return found
}

/** Tell every observer watching this element's attributes. */
function notifyAttributeObservers(element, name) {
  for (const observer of element.observers.slice()) {
    const options = observer.options ?? {}
    if (options.attributes === false) continue
    if (Array.isArray(options.attributeFilter) && options.attributeFilter.indexOf(name) === -1) continue
    observer.callback([{ type: 'attributes', target: element, attributeName: name }], observer)
  }
}

/**
 * One fake element.
 *
 * `document.createElement` records what it hands out (the stylesheet checks read
 * that list); the renderer's own host elements are not recorded.
 */
function createFakeElement(tag) {
  const element = {
    tag,
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    attributes: new Map(),
    style: createStyleObject(),
    childNodes: [],
    parentNode: null,
    listeners: [],
    observers: [],
    captured: new Set(),
    rect: null,
    removed: false,
    text: '',
  }

  const detach = (node) => {
    if (node.parentNode === null || node.parentNode === undefined) return
    const at = node.parentNode.childNodes.indexOf(node)
    if (at !== -1) node.parentNode.childNodes.splice(at, 1)
    node.parentNode = null
  }

  element.setAttribute = (name, value) => {
    element.attributes.set(name, String(value))
    notifyAttributeObservers(element, name)
  }
  element.removeAttribute = (name) => {
    if (!element.attributes.has(name)) return
    element.attributes.delete(name)
    notifyAttributeObservers(element, name)
  }
  element.getAttribute = (name) => (element.attributes.has(name) ? element.attributes.get(name) : null)
  element.hasAttribute = (name) => element.attributes.has(name)
  element.getAttributeNames = () => Array.from(element.attributes.keys())
  element.toggleAttribute = (name, force) => {
    const want = force === undefined ? !element.hasAttribute(name) : force === true
    if (want) element.setAttribute(name, '')
    else element.removeAttribute(name)
    return want
  }

  element.appendChild = (node) => { detach(node); node.parentNode = element; element.childNodes.push(node); return node }
  element.insertBefore = (node, reference) => {
    detach(node)
    node.parentNode = element
    if (reference === null || reference === undefined) {
      element.childNodes.push(node)
      return node
    }
    const at = element.childNodes.indexOf(reference)
    if (at === -1) element.childNodes.push(node)
    else element.childNodes.splice(at, 0, node)
    return node
  }
  element.removeChild = (node) => { detach(node); return node }
  element.replaceChildren = (...nodes) => {
    for (const node of element.childNodes.slice()) detach(node)
    for (const node of nodes) element.appendChild(node)
  }
  element.remove = () => { element.removed = true; detach(element) }
  element.contains = (node) => {
    let current = node
    while (current !== null && current !== undefined) {
      if (current === element) return true
      current = current.parentNode
    }
    return false
  }

  element.querySelector = (selector) => {
    const found = queryAll(element, selector, true)
    return found.length === 0 ? null : found[0]
  }
  element.querySelectorAll = (selector) => queryAll(element, selector, false)
  element.matches = (selector) => selectorMatcher(selector)(element)
  element.closest = (selector) => {
    const matches = selectorMatcher(selector)
    let current = element
    while (current !== null && current !== undefined) {
      if (current.nodeType === 1 && matches(current)) return current
      current = current.parentNode
    }
    return null
  }

  element.addEventListener = (type, handler, options) => {
    const capture = options === true || (options !== null && typeof options === 'object' && options.capture === true)
    const known = element.listeners.some((entry) => entry.type === type && entry.handler === handler && entry.capture === capture)
    if (!known) element.listeners.push({ type, handler, capture })
  }
  element.removeEventListener = (type, handler, options) => {
    const capture = options === true || (options !== null && typeof options === 'object' && options.capture === true)
    const at = element.listeners.findIndex((entry) => entry.type === type && entry.handler === handler && entry.capture === capture)
    if (at !== -1) element.listeners.splice(at, 1)
  }
  element.dispatchEvent = (event) => {
    const path = []
    let node = element
    while (node !== null && node !== undefined) { path.push(node); node = node.parentNode }
    event.target = event.target ?? element
    const invoke = (target, capture) => {
      const handlers = target.listeners.filter((entry) => entry.type === event.type && entry.capture === capture)
      for (const entry of handlers) {
        event.currentTarget = target
        entry.handler.call(target, event)
        if (event.stopped === true) return
      }
    }
    // Capture phase, outermost in; then the target's own bubble listeners; then up.
    for (let index = path.length - 1; index >= 0; index -= 1) {
      if (event.stopped === true) break
      invoke(path[index], true)
    }
    if (event.stopped !== true) invoke(element, false)
    for (let index = 1; index < path.length; index += 1) {
      if (event.stopped === true) break
      invoke(path[index], false)
    }
    return event.defaultPrevented !== true
  }

  element.getBoundingClientRect = () => {
    const rect = element.rect ?? { left: 0, top: 0, width: 0, height: 0 }
    const left = rect.left ?? 0
    const top = rect.top ?? 0
    const width = rect.width ?? 0
    const height = rect.height ?? 0
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }
  }

  element.setPointerCapture = (pointerId) => { element.captured.add(pointerId) }
  element.hasPointerCapture = (pointerId) => element.captured.has(pointerId)
  element.releasePointerCapture = (pointerId) => { element.captured.delete(pointerId) }

  Object.defineProperty(element, 'children', {
    get: () => element.childNodes.filter((node) => node.nodeType === 1),
  })
  Object.defineProperty(element, 'firstChild', { get: () => element.childNodes[0] ?? null })
  Object.defineProperty(element, 'lastChild', { get: () => element.childNodes[element.childNodes.length - 1] ?? null })
  Object.defineProperty(element, 'firstElementChild', { get: () => element.childNodes.find((node) => node.nodeType === 1) ?? null })
  Object.defineProperty(element, 'nextSibling', {
    get: () => {
      if (element.parentNode === null) return null
      const at = element.parentNode.childNodes.indexOf(element)
      return at === -1 ? null : (element.parentNode.childNodes[at + 1] ?? null)
    },
  })
  Object.defineProperty(element, 'previousSibling', {
    get: () => {
      if (element.parentNode === null) return null
      const at = element.parentNode.childNodes.indexOf(element)
      return at <= 0 ? null : element.parentNode.childNodes[at - 1]
    },
  })
  Object.defineProperty(element, 'nextElementSibling', {
    get: () => {
      const nodes = element.parentNode === null ? [] : element.parentNode.children
      const at = nodes.indexOf(element)
      return at === -1 ? null : (nodes[at + 1] ?? null)
    },
  })
  Object.defineProperty(element, 'previousElementSibling', {
    get: () => {
      const nodes = element.parentNode === null ? [] : element.parentNode.children
      const at = nodes.indexOf(element)
      return at <= 0 ? null : nodes[at - 1]
    },
  })
  Object.defineProperty(element, 'parentElement', {
    get: () => (element.parentNode !== null && element.parentNode.nodeType === 1 ? element.parentNode : null),
  })
  Object.defineProperty(element, 'className', {
    get: () => element.getAttribute('class') ?? '',
    set: (value) => { element.setAttribute('class', String(value)) },
  })
  Object.defineProperty(element, 'classList', { get: () => classListOf(element) })
  Object.defineProperty(element, 'textContent', {
    get: () => (element.childNodes.length === 0
      ? element.text
      : element.childNodes.map((node) => node.textContent).join('')),
    set: (value) => {
      for (const node of element.childNodes.slice()) detach(node)
      element.text = String(value)
    },
  })
  return element
}

/** One fake text node; the renderer creates these for string children. */
function createTextNode(value) {
  const node = { nodeType: 3, nodeName: '#text', textContent: String(value), parentNode: null }
  Object.defineProperty(node, 'nextSibling', {
    get: () => {
      if (node.parentNode === null) return null
      const at = node.parentNode.childNodes.indexOf(node)
      return at === -1 ? null : (node.parentNode.childNodes[at + 1] ?? null)
    },
  })
  return node
}

/**
 * The frame's centre column, faked down to attributes and a box.
 *
 * The column carries no attribute of its own in the shipped frame, so the plugin
 * publishes one and the appearance depends on it: this is the only place that protocol
 * can be observed without a browser. The frame nests the column and the overlay
 * layer exactly the way the shell's grid does, because the overlay measures the
 * column through that relationship.
 */
const domCenter = createFakeElement('div')
const domRightbar = createFakeElement('aside')
domRightbar.setAttribute('data-rightbar-col', '')
const domFrame = createFakeElement('div')
const domLayer = createFakeElement('div')
domLayer.setAttribute('data-shell-overlay', '')
domFrame.appendChild(domCenter)
domFrame.appendChild(domRightbar)
domFrame.appendChild(domLayer)
const domBody = createFakeElement('body')
const domHead = createFakeElement('head')
domBody.appendChild(domFrame)

const createdElements = []

globalThis.document = {
  body: domBody,
  head: domHead,
  documentElement: domBody,
  createElement: (tag) => {
    const element = createFakeElement(tag)
    createdElements.push(element)
    return element
  },
  createTextNode: (value) => createTextNode(value),
  querySelector: (selector) => domBody.querySelector(selector),
  querySelectorAll: (selector) => domBody.querySelectorAll(selector),
  elementFromPoint: (x, y) => elementFromPoint(x, y),
  addEventListener: () => {},
  removeEventListener: () => {},
}

/** The deepest element whose box contains the point, the way hit testing would find it. */
function elementFromPoint(x, y) {
  let best = null
  let bestArea = Infinity
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue
      const rect = child.rect
      if (rect !== null && rect !== undefined
        && x >= (rect.left ?? 0) && x < (rect.left ?? 0) + (rect.width ?? 0)
        && y >= (rect.top ?? 0) && y < (rect.top ?? 0) + (rect.height ?? 0)) {
        const area = (rect.width ?? 0) * (rect.height ?? 0)
        if (area <= bestArea) { bestArea = area; best = child }
      }
      visit(child)
    }
  }
  visit(domBody)
  return best
}

/* ---------------------------------------------------------------- *
 * Recording observers
 *
 * Both fakes keep the callback and the targets, so a check can fire one the way
 * the browser would and can also see whether it was ever disconnected.
 * ---------------------------------------------------------------- */

const resizeObservers = []
const mutationObservers = []

globalThis.ResizeObserver = class ResizeObserverStub {
  constructor(callback) {
    this.callback = callback
    this.targets = []
    this.disconnected = false
    resizeObservers.push(this)
  }

  observe(target) {
    if (this.targets.indexOf(target) === -1) this.targets.push(target)
  }

  unobserve(target) {
    this.targets = this.targets.filter((item) => item !== target)
  }

  disconnect() {
    this.disconnected = true
    this.targets = []
  }
}

/** Observers that are still watching something. */
function liveResizeObservers() {
  return resizeObservers.filter((observer) => !observer.disconnected && observer.targets.length > 0)
}

/** Fire every live ResizeObserver, the way a track move or a resize would. */
function triggerResizeObservers() {
  for (const observer of liveResizeObservers()) observer.callback([], observer)
}

globalThis.MutationObserver = class MutationObserverStub {
  constructor(callback) {
    this.callback = callback
    this.options = {}
    this.targets = []
    this.disconnected = false
    mutationObservers.push(this)
  }

  observe(target, options) {
    this.options = options ?? {}
    if (this.targets.indexOf(target) === -1) this.targets.push(target)
    if (target.observers.indexOf(this) === -1) target.observers.push(this)
  }

  takeRecords() { return [] }

  disconnect() {
    this.disconnected = true
    for (const target of this.targets) target.observers = target.observers.filter((item) => item !== this)
    this.targets = []
  }
}

/** Run every queued animation frame callback once. */
function flushFrames() {
  const queued = frames.splice(0, frames.length)
  for (const frame of queued) frame.callback()
}

/** The persisted layout, or null: a "stops persisting" regression must fail a check, not crash. */
function storedLayout() {
  const raw = storage.get('dsh.split.v1')
  if (raw === undefined || raw === null) return null
  try { return JSON.parse(raw) } catch (error) { return null }
}

/** Run every queued timer, oldest first, honouring cancellation. */
function flushTimers() {
  const queued = timers.splice(0, timers.length)
  for (const entry of queued) if (!entry.cancelled) entry.callback()
}

/**
 * Run the effects a render registered.
 *
 * Outside `createRoot` these are the raw effects a directly-called component
 * recorded; inside it, each entry runs the previous cleanup when its dependencies
 * changed and then the effect itself, which is React's passive-effect contract.
 */
function flushEffects() {
  const queued = pendingEffects.splice(0, pendingEffects.length)
  for (const effect of queued) effect()
}

/**
 * Scripted local state for the direct-call tier.
 *
 * `useState` values are consumed by *type* — string, object, number — rather than by
 * call order, so a test can put the overlay into a state its own effects would reach
 * in the browser (a staged pane body, a drag in flight) without a React runtime.
 * This is only the fallback: inside `createRoot` the hooks below are real.
 */
let stateScript = []
let stateUsed = new Set()

/* ---------------------------------------------------------------- *
 * React stub
 *
 * Two modes, one object. Outside a render — a test calling a component directly,
 * which is how the tree-walking checks above work — every hook behaves like the
 * original recording stub. Inside a render the hooks are real: per-instance state
 * that re-renders its subtree, refs that survive, memos that compare, effects with
 * dependency tracking and cleanup, and a `memo` boundary that really skips a
 * subtree. It is not React: no scheduling, no priorities, no context.
 * ---------------------------------------------------------------- */

let currentFiber = null
let currentRoot = null

/** Stable per-type key, so keyed matching can compare types by identity. */
const typeIds = new Map()
function typeKeyOf(type) {
  const known = typeIds.get(type)
  if (known !== undefined) return known
  const key = 't' + String(typeIds.size)
  typeIds.set(type, key)
  return key
}

function slotKey(type, key, index) {
  if (key !== undefined && key !== null) return typeKeyOf(type) + '\u0001k:' + String(key)
  return typeKeyOf(type) + '\u0001i:' + String(index)
}

function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false
  if (previous.length !== next.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (!Object.is(previous[index], next[index])) return false
  }
  return true
}

/** React's shallow prop comparison, which is what `memo` defaults to. */
function shallowEqual(previous, next) {
  if (Object.is(previous, next)) return true
  if (previous === null || next === null || typeof previous !== 'object' || typeof next !== 'object') return false
  const previousKeys = Object.keys(previous)
  const nextKeys = Object.keys(next)
  if (previousKeys.length !== nextKeys.length) return false
  for (const key of previousKeys) if (!Object.is(previous[key], next[key])) return false
  return true
}

/* ---- hooks ------------------------------------------------------- */

function useHookSlot() {
  const fiber = currentFiber
  const index = fiber.hookIndex
  fiber.hookIndex += 1
  if (fiber.hooks.length <= index) fiber.hooks.push({ kind: null })
  return fiber.hooks[index]
}

function markDirty(fiber) {
  let current = fiber
  while (current !== null && current !== undefined) {
    current.dirty = true
    current = current.parent
  }
}

function scheduleRerender(root) {
  if (root === null || root === undefined || root.unmounted) return
  if (root.committing) { root.rerenderPending = true; return }
  commitRoot(root)
}

function declareEffect(create, deps, layout) {
  // Outside a render the effect is merely recorded: the tree-walking tier flushes
  // them by hand, exactly as it did before there was a renderer.
  if (currentFiber === null) { pendingEffects.push(create); return }
  const fiber = currentFiber
  const root = currentRoot
  const slot = useHookSlot()
  const first = slot.kind !== 'effect'
  const changed = first || !sameDeps(slot.deps, deps)
  if (first) slot.kind = 'effect'
  // Memoized on the dependency identity, so a render with unchanged deps must not
  // reschedule the effect: that is what keeps a re-render from re-running cleanup.
  slot.deps = deps
  if (!changed) return
  const run = () => {
    if (fiber.unmounted) return
    if (typeof slot.cleanup === 'function') {
      const previous = slot.cleanup
      slot.cleanup = undefined
      previous()
    }
    const returned = create()
    slot.cleanup = typeof returned === 'function' ? returned : undefined
  }
  if (layout) root.layoutQueue.push(run)
  else pendingEffects.push(run)
}

const ReactStub = {
  // A plain tree, so a component can be called as a function and its output walked.
  // Children land in `props.children` too, the way React's own createElement does,
  // so a pass-through component (the SessionProvider stand-in) can render them.
  createElement: (type, props, ...children) => {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged, children }
  },
  Fragment: { $$typeof: Symbol('fragment') },
  /**
   * A real memo boundary.
   *
   * The wrapper stays a plain function so the direct-call tier can still invoke a
   * component through `node.type(props)`; the renderer reads `$$memo` and skips the
   * subtree when the props are shallow-equal.
   */
  memo: (component, compare) => {
    const wrapped = function memoized(props) { return component(props) }
    wrapped.$$memo = { component, compare: typeof compare === 'function' ? compare : null }
    return wrapped
  },
  cloneElement: (element, props, ...children) => {
    const merged = { ...(element.props ?? {}), ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type: element.type, props: merged, children: children.length === 0 ? element.children : children }
  },
  useState: (init) => {
    if (currentFiber === null) {
      const fallback = typeof init === 'function' ? init() : init
      const kind = typeof fallback
      for (let index = 0; index < stateScript.length; index += 1) {
        if (stateUsed.has(index) || typeof stateScript[index] !== kind) continue
        stateUsed.add(index)
        return [stateScript[index], () => {}]
      }
      return [fallback, () => {}]
    }
    const fiber = currentFiber
    const slot = useHookSlot()
    if (slot.kind !== 'state') {
      slot.kind = 'state'
      slot.value = typeof init === 'function' ? init() : init
    }
    if (slot.setter === undefined) {
      slot.setter = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        markDirty(fiber)
        scheduleRerender(fiber.root)
      }
    }
    return [slot.value, slot.setter]
  },
  useRef: (init) => {
    if (currentFiber === null) return { current: init }
    const slot = useHookSlot()
    if (slot.kind !== 'ref') { slot.kind = 'ref'; slot.value = { current: init } }
    return slot.value
  },
  useMemo: (factory, deps) => {
    if (currentFiber === null) return factory()
    const slot = useHookSlot()
    if (slot.kind !== 'memo' || !sameDeps(slot.deps, deps)) {
      slot.kind = 'memo'
      slot.deps = deps
      slot.value = factory()
    }
    return slot.value
  },
  useCallback: (callback, deps) => ReactStub.useMemo(() => callback, deps),
  useEffect: (create, deps) => { declareEffect(create, deps, false) },
  useLayoutEffect: (create, deps) => { declareEffect(create, deps, true) },
  /**
   * The store binding the overlay's `useSplit` sits on.
   *
   * Subscribed once per mount and re-subscribed when the source changes; a
   * notification re-renders the component only when the selected value moved,
   * which is what lets a focus move reach the paint effect without touching panes.
   */
  useSyncExternalStore: (subscribe, getSnapshot) => {
    if (currentFiber === null) return getSnapshot()
    const fiber = currentFiber
    const root = currentRoot
    const slot = useHookSlot()
    if (slot.kind !== 'store') {
      slot.kind = 'store'
      slot.value = getSnapshot()
      slot.subscribe = null
      slot.unsubscribe = null
    }
    slot.getSnapshot = getSnapshot
    const value = getSnapshot()
    if (!Object.is(value, slot.value)) slot.value = value
    if (slot.subscribe !== subscribe || slot.unsubscribe === null) {
      slot.subscribe = subscribe
      root.storeQueue.push(() => {
        if (fiber.unmounted) return
        if (typeof slot.unsubscribe === 'function') {
          const previous = slot.unsubscribe
          slot.unsubscribe = null
          previous()
        }
        slot.unsubscribe = subscribe(() => {
          if (fiber.unmounted) return
          const next = slot.getSnapshot()
          if (Object.is(next, slot.value)) return
          slot.value = next
          markDirty(fiber)
          scheduleRerender(fiber.root)
        })
      })
    }
    return slot.value
  },
}

/* ---- renderer ---------------------------------------------------- */

function createFiber(type, key, root, parent) {
  return {
    type,
    key: key ?? null,
    root,
    parent,
    props: null,
    hooks: [],
    hookIndex: 0,
    children: [],
    dom: null,
    ref: undefined,
    dirty: false,
    unmounted: false,
    index: 0,
    text: null,
  }
}

function createTextFiber(value, root, parent) {
  const fiber = createFiber('#text', null, root, parent)
  fiber.text = String(value)
  fiber.dom = createTextNode(fiber.text)
  return fiber
}

/** A host element the renderer owns; not recorded the way document.createElement is. */
function createHostElement(tag) {
  return createFakeElement(tag)
}

const EVENT_NAMES = { onDoubleClick: 'dblclick' }

function setListener(element, propName, previous, next) {
  const capture = propName.endsWith('Capture')
  const type = EVENT_NAMES[propName]
    ?? (capture ? propName.slice(2, -7) : propName.slice(2)).toLowerCase()
  if (typeof previous === 'function') element.removeEventListener(type, previous, capture)
  if (typeof next === 'function') element.addEventListener(type, next, capture)
}

function assignStyle(target, previous, next) {
  const names = new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})])
  for (const name of names) {
    const value = next === null || next === undefined ? undefined : next[name]
    if (value === undefined || value === null) delete target[name]
    else target[name] = String(value)
  }
}

/** Push one render's props onto a host element: attributes, style, listeners, refs. */
function applyProps(element, previous, next) {
  const previousRef = previous === null || previous === undefined ? undefined : previous.ref
  const nextRef = next === null || next === undefined ? undefined : next.ref
  if (previousRef !== nextRef) {
    if (previousRef !== undefined && previousRef !== null && typeof previousRef !== 'function') previousRef.current = null
    if (nextRef !== undefined && nextRef !== null && typeof nextRef !== 'function') nextRef.current = element
    if (typeof nextRef === 'function') nextRef(element)
  } else if (nextRef !== undefined && nextRef !== null && typeof nextRef !== 'function' && nextRef.current !== element) {
    nextRef.current = element
  }
  const names = new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})])
  for (const name of names) {
    if (name === 'children' || name === 'key' || name === 'ref') continue
    const value = next === null || next === undefined ? undefined : next[name]
    const before = previous === null || previous === undefined ? undefined : previous[name]
    if (value === before) continue
    if (name === 'style') { assignStyle(element.style, before, value); continue }
    if (name === 'className') {
      if (value === null || value === undefined || value === false) element.removeAttribute('class')
      else element.setAttribute('class', String(value))
      continue
    }
    if (name.startsWith('on') && (typeof value === 'function' || typeof before === 'function')) {
      setListener(element, name, before, value)
      continue
    }
    if (value === null || value === undefined || value === false) { element.removeAttribute(name); continue }
    if (value === true) { element.setAttribute(name, ''); continue }
    element.setAttribute(name, String(value))
  }
}

function flattenElements(elements, out) {
  for (const element of elements) {
    if (Array.isArray(element)) { flattenElements(element, out); continue }
    out.push(element)
  }
}

/** Every DOM node a fiber owns, in document order (a component owns its children's). */
function collectDom(fiber, out) {
  if (fiber.dom !== null) { out.push(fiber.dom); return }
  for (const child of fiber.children) collectDom(child, out)
}

/** Put a parent's DOM children back into render order. */
function orderDom(parentDom, fibers) {
  const doms = []
  for (const fiber of fibers) collectDom(fiber, doms)
  let anchor = null
  for (let index = doms.length - 1; index >= 0; index -= 1) {
    const dom = doms[index]
    if (dom.parentNode !== parentDom || dom.nextSibling !== anchor) parentDom.insertBefore(dom, anchor)
    anchor = dom
  }
}

function unmountFiber(fiber) {
  if (fiber.unmounted) return
  fiber.unmounted = true
  const ref = fiber.ref
  if (ref !== undefined && ref !== null && typeof ref !== 'function' && typeof ref === 'object') ref.current = null
  for (let index = fiber.hooks.length - 1; index >= 0; index -= 1) {
    const slot = fiber.hooks[index]
    if (typeof slot.cleanup === 'function') {
      const run = slot.cleanup
      slot.cleanup = undefined
      run()
    }
    if (typeof slot.unsubscribe === 'function') {
      const run = slot.unsubscribe
      slot.unsubscribe = null
      run()
    }
  }
  for (const child of fiber.children) unmountFiber(child)
  if (fiber.dom !== null && fiber.dom.parentNode !== null && fiber.dom.parentNode !== undefined) {
    fiber.dom.parentNode.removeChild(fiber.dom)
  }
}

function reconcileElement(parentDom, oldByKey, element, index, root, parentFiber, used) {
  const elementKey = element.props === null || element.props === undefined ? undefined : element.props.key
  const key = slotKey(element.type, elementKey, index)
  let fiber = oldByKey.get(key)
  if (fiber === undefined || used.has(fiber) || fiber.type !== element.type) {
    fiber = createFiber(element.type, elementKey, root, parentFiber)
  }
  used.add(fiber)
  fiber.index = index
  fiber.parent = parentFiber
  fiber.root = root
  fiber.unmounted = false

  if (typeof element.type === 'string') {
    const dom = fiber.dom ?? (fiber.dom = createHostElement(element.type))
    const changed = fiber.props !== element.props || fiber.dirty
    if (changed) applyProps(dom, fiber.props, element.props)
    fiber.props = element.props
    fiber.ref = element.props.ref
    fiber.dirty = false
    if (changed || fiber.children.length === 0) {
      fiber.children = reconcileChildren(dom, fiber.children, element.children, root, fiber)
    }
    orderDom(dom, fiber.children)
    return fiber
  }

  const memo = element.type.$$memo
  const canBail = fiber.props !== null && !fiber.dirty
    && (memo === undefined
      ? fiber.props === element.props
      : (memo.compare ?? shallowEqual)(fiber.props, element.props))
  if (canBail) {
    // Skipped entirely: no hook runs, no effect re-runs, no child is re-invoked.
    fiber.props = element.props
    return fiber
  }
  const component = memo === undefined ? element.type : memo.component
  const previousFiber = currentFiber
  const previousRoot = currentRoot
  currentFiber = fiber
  currentRoot = root
  fiber.hookIndex = 0
  fiber.props = element.props
  fiber.dirty = false
  let output
  try {
    output = component(element.props)
  } finally {
    currentFiber = previousFiber
    currentRoot = previousRoot
  }
  fiber.children = reconcileChildren(parentDom, fiber.children, [output], root, fiber)
  return fiber
}

function reconcileChildren(parentDom, oldFibers, elements, root, parentFiber) {
  const flat = []
  flattenElements(elements, flat)
  const oldByKey = new Map()
  for (let index = 0; index < oldFibers.length; index += 1) {
    const fiber = oldFibers[index]
    oldByKey.set(slotKey(fiber.type, fiber.key, fiber.index), fiber)
  }
  const next = []
  const used = new Set()
  for (let index = 0; index < flat.length; index += 1) {
    const element = flat[index]
    if (element === null || element === undefined || typeof element === 'boolean') continue
    if (typeof element === 'string' || typeof element === 'number') {
      const key = slotKey('#text', null, index)
      let fiber = oldByKey.get(key)
      if (fiber === undefined || used.has(fiber) || fiber.type !== '#text') {
        fiber = createTextFiber(element, root, parentFiber)
      }
      used.add(fiber)
      fiber.index = index
      fiber.parent = parentFiber
      fiber.unmounted = false
      if (fiber.text !== String(element)) {
        fiber.text = String(element)
        fiber.dom.textContent = fiber.text
      }
      next.push(fiber)
      continue
    }
    next.push(reconcileElement(parentDom, oldByKey, element, index, root, parentFiber, used))
  }
  for (const fiber of oldFibers) if (!used.has(fiber)) unmountFiber(fiber)
  orderDom(parentDom, next)
  return next
}

function commitRoot(root) {
  if (root.unmounted) return
  const previousFiber = currentFiber
  const previousRoot = currentRoot
  root.committing = true
  try {
    let guard = 0
    do {
      root.rerenderPending = false
      root.layoutQueue = []
      root.storeQueue = []
      root.fibers = reconcileChildren(root.container, root.fibers, [root.element], root, null)
      for (const run of root.storeQueue.splice(0, root.storeQueue.length)) run()
      for (const run of root.layoutQueue.splice(0, root.layoutQueue.length)) run()
      guard += 1
    } while (root.rerenderPending && !root.unmounted && guard < 25)
  } finally {
    root.committing = false
    currentFiber = previousFiber
    currentRoot = previousRoot
  }
}

/**
 * Mount an element into a container, the way the shell mounts a slot occupant.
 *
 * `render` re-renders from the root element; `unmount` runs every cleanup and
 * detaches the DOM. Passive effects are queued for `flushEffects()`, layout
 * effects run at the end of the commit (the plugin measures the column there and
 * depends on the box existing before the first paint).
 */
function createRoot(container) {
  const root = {
    container,
    element: null,
    fibers: [],
    layoutQueue: [],
    storeQueue: [],
    committing: false,
    rerenderPending: false,
    unmounted: false,
  }
  return {
    root,
    container,
    render(element) {
      root.unmounted = false
      root.element = element
      commitRoot(root)
    },
    unmount() {
      const fibers = root.fibers
      root.fibers = []
      root.unmounted = true
      for (const fiber of fibers) unmountFiber(fiber)
    },
  }
}

const PrimitivesStub = {
  Button: () => null,
  Tooltip: () => null,
  StateDot: () => null,
  MenuItemButton: () => null,
  IconCloseOutlineRegular: () => null,
  IconCompareSplitOutlineRegular: () => null,
  IconPanelLeftOutlineRegular: () => null,
}

const requireStub = (specifier) => {
  if (specifier === 'react') return ReactStub
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return PrimitivesStub
  throw new Error('unit-bundle: unexpected require("' + specifier + '")')
}

/* ---------------------------------------------------------------- *
 * Recording fake context
 * ---------------------------------------------------------------- */

function createFakeContext() {
  const slots = []
  const fixed = []
  const retained = []
  const released = []
  const events = []
  const toggles = []
  const listListeners = new Set()
  const panelListeners = new Set()
  const currentListeners = new Set()
  const effectDisposers = []

  let listState = { phase: 'pending', ids: [], byId: {} }
  let activePanel = null
  let currentKey = undefined
    const rightbarBySession = {}
    let rightbarCurrent = null
  let fixedInputListener = null
  const consumed = []

  const ctx = {
    effect: (callback) => {
      const returned = callback()
      const dispose = () => { if (typeof returned === 'function') returned() }
      effectDisposers.push(dispose)
      return dispose
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (key, callback) => {
        const dispose = callback()
        return () => { if (typeof dispose === 'function') dispose() }
      },
      register: (options, component) => {
        slots.push({ options, component })
        return () => {}
      },
    },
    sessions: {
      list: {
        getSnapshot: () => listState,
        subscribe: (listener) => { listListeners.add(listener); return () => { listListeners.delete(listener) } },
      },
      retain: (sessionId, options) => {
        // Mirrors the real service: an uncatalogued id throws, which is what
        // keeps a deleted Session from being restored into the layout.
        if (listState.byId[sessionId] === undefined) {
          throw new Error('sessions.retain: unknown session ' + String(sessionId))
        }
        retained.push({ sessionId, options })
        let live = true
        const reference = {
          sessionId,
          binding: { sessionId },
          ready: Promise.resolve({ sessionId }),
          // Recorded, and idempotent like the real reference: a second release must
          // not count, so a double release in the plugin shows up as a mismatch.
          release: () => {
            if (!live) return
            live = false
            released.push(sessionId)
          },
        }
        // The real service opens the Session here, which publishes the list again — the
        // re-entrancy the plugin's in-flight marker exists for.
        for (const listener of listListeners) listener()
        return reference
      },
    },
    layout: {
      panelInfo: {
        getSnapshot: () => ({ activePanelId: activePanel }),
        subscribe: (listener) => { panelListeners.add(listener); return () => { panelListeners.delete(listener) } },
      },
      selectPanel: (id) => {
        activePanel = id
        events.push('panel:' + String(id))
        for (const listener of panelListeners) listener()
      },
    },
    uiSession: {
      adapter: {
        current: {
          getSnapshot: () => ({ key: currentKey }),
          subscribe: (listener) => { currentListeners.add(listener); return () => { currentListeners.delete(listener) } },
        },
      },
    },
    uiWorkspace: {
      openSession: (sessionId) => {
        events.push('open:' + String(sessionId))
        currentKey = String(sessionId)
        rightbarCurrent = String(sessionId)
        for (const listener of currentListeners) listener()
      },
    },
    sidebarRight: {
      isExpanded: () => rightbarBySession[rightbarCurrent] === true,
      toggleExpanded: () => {
        toggles.push('toggle')
        rightbarBySession[rightbarCurrent] = rightbarBySession[rightbarCurrent] !== true
      },
    },
    shortcuts: {
      registerFixed: (command) => { fixed.push(command); return () => {} },
      observeFixedInput: (listener) => { fixedInputListener = listener; return () => {} },
    },
  }

  return {
    ctx,
    slots,
    fixed,
    retained,
    released,
    events,
    toggles,
    setList(next) {
      listState = next
      for (const listener of listListeners) listener()
    },
    setCurrent(key) {
      currentKey = key
      rightbarCurrent = String(key)
      for (const listener of currentListeners) listener()
    },
    setActive(id) {
      activePanel = id
      events.push('panel:' + String(id))
      for (const listener of panelListeners) listener()
    },
    /** Deliver one reserved Ctrl+Alt chord the way the shortcut adapter does. */
    pressFixed(code) {
      if (fixedInputListener === null) throw new Error('no fixed-input listener')
      fixedInputListener({
        type: 'keydown',
        gesture: { code, control: true, alt: true, shift: false, meta: false, repeat: false, composing: false, defaultPrevented: false },
        context: { modal: null },
        consume: () => { consumed.push(code) },
      })
    },
    getActive: () => activePanel,
    rightbar: {
      set: (sessionId, open) => { rightbarBySession[sessionId] = open === true },
      get: (sessionId) => rightbarBySession[sessionId] === true,
    },
    consumed: () => consumed,
    /** Tear the plugin down the way cordis does: effects in reverse order. */
    disposeAll() {
      for (const dispose of effectDisposers.slice().reverse()) dispose()
    },
  }
}

/* ---------------------------------------------------------------- *
 * Run
 * ---------------------------------------------------------------- */

console.log('dsh-split bundle smoke test\n')

await import(pathToFileURL(bundlePath).href)

console.log('registration')
check('exactly one __ModuleLoader__.load call', registrations.length === 1, String(registrations.length))
const registration = registrations[0]
check('registration id is the package name', registration !== undefined && registration.id === 'dsh-split')
check('factory is a function', registration !== undefined && typeof registration.factory === 'function')

const exportsObject = registration.factory(requireStub)

console.log('\nexports')
check('apply is a function', typeof exportsObject.apply === 'function')
const injected = exportsObject.inject
check('declares every service it reads',
  Array.isArray(injected)
  && ['slots', 'sessions', 'layout', 'uiSession', 'uiWorkspace', 'sidebarRight', 'locale', 'shortcuts']
    .every((name) => injected.includes(name)),
  JSON.stringify(injected))

const fake = createFakeContext()
exportsObject.apply(fake.ctx)

console.log('\nslot registrations')
const byName = (name) => fake.slots.filter((entry) => entry.options.name === name)
const overlay = byName('shell.overlay')
check('one overlay entry, so the panel selection is never taken', overlay.length === 1)
check('overlay id is the package name', overlay[0] !== undefined && overlay[0].options.id === 'dsh-split')
check('declares the session-scoped pane child',
  overlay[0] !== undefined && overlay[0].options.children !== undefined
  && overlay[0].options.children['split.pane'] !== undefined
  && overlay[0].options.children['split.pane'].scope === 'session')
check('one pane occupant', byName('split.pane').length === 1)

const voids = byName('main').filter((entry) => entry.options.key === 'dsh-split-void')
check('one empty switch panel for the remount repair', voids.length === 1)
check('the switch panel renders nothing', voids[0] !== undefined && voids[0].component() === null)
check('no panel owns the conversation key',
  byName('main').every((entry) => entry.options.key !== 'conversation'))
check('no Sidebar panel-rail entry', byName('sidebar.panellist').length === 0)
check('no Sidebar row hover button', byName('sidebar.workspaces.session.row.action').length === 0)

const menu = byName('sidebar.workspaces.session.menu.item')
check('two Session menu entries', menu.length === 2, String(menu.length))
check('menu ids are the two directions',
  menu.map((entry) => entry.options.id).sort().join(',') === 'dsh-split.down,dsh-split.right',
  menu.map((entry) => entry.options.id).join(','))
check('no shipped slot was shadowed',
  fake.slots.every((entry) => ['shell.overlay', 'split.pane', 'main', 'sidebar.workspaces.session.menu.item']
    .indexOf(entry.options.name) !== -1),
  fake.slots.map((entry) => entry.options.name).join(','))

console.log('\nshortcuts')
check('three fixed commands', fake.fixed.length === 3, String(fake.fixed.length))
check('command ids are namespaced', fake.fixed.every((command) => command.id.startsWith('dsh-split.')))
// The service reserves each binding and throws on an unknown modifier, so the shape
// is a load-time contract, not a detail.
const MODIFIERS = ['primary', 'control', 'alt', 'shift', 'meta']
check('every reserved binding is well formed', fake.fixed.every((command) =>
  Array.isArray(command.bindings) && command.bindings.length > 0
  && command.bindings.every((binding) => typeof binding.code === 'string' && binding.code !== ''
    && Array.isArray(binding.modifiers) && binding.modifiers.length > 0
    && binding.modifiers.every((modifier) => MODIFIERS.indexOf(modifier) !== -1))))
check('the display keys match the reserved bindings',
  fake.fixed.every((command) => Array.isArray(command.keys) && command.keys.length === command.bindings.length),
  fake.fixed.map((command) => command.keys.join('|')).join(' , '))

console.log('\ncontroller: layout, references, overlay')
const face = overlay[0].options.inject()
const menuFace = menu[0].options.inject()
const snapshot = () => face.hooks.split.getSnapshot()
const panesNow = () => listOf(snapshot().root)

fake.setList({ phase: 'ready', ids: ['s1', 's2', 's3', 's4', 's5'], byId: { s1: {}, s2: {}, s3: {}, s4: {}, s5: {} } })
check('a fresh layout is one empty pane', snapshot().root.t === 'p' && snapshot().root.s === null)
check('the overlay starts closed', snapshot().open === false)
check('no reference before a Session is chosen', snapshot().refs.size === 0)

fake.setCurrent('s1')
check('the menu action opens the split view', menuFace.run('s2') === true)
check('the overlay is open', snapshot().open === true)
check('opening never touches the panel selection', fake.getActive() === null, String(fake.getActive()))
check('two panes after the first split', panesNow().length === 2)
check('the panes hold the current Session and the chosen one',
  panesNow().map((pane) => pane.s).join(',') === 's1,s2',
  panesNow().map((pane) => pane.s).join(','))
check('two retained references', snapshot().refs.size === 2)
check('reference source is private', fake.retained.every((entry) => entry.options.source === 'splitPane'))

const panesBefore = panesNow().map((pane) => pane.id).join(',')
check('acting on an on-screen Session is a no-op', menuFace.run('s1') === true)
check('no pane was added', panesNow().map((pane) => pane.id).join(',') === panesBefore)
check('the menu stays enabled for an on-screen Session', menuFace.canSplit('s1') === true)
check('a third pane is allowed', menuFace.run('s3') === true && panesNow().length === 3)
check('a fourth pane is allowed', menuFace.run('s4') === true && panesNow().length === 4)
check('the pane ceiling refuses a fifth', menuFace.run('s5') === false)
check('the ceiling is reported to the menu', menuFace.canSplit('s5') === false)

const firstPane = panesNow()[0]
const secondPane = panesNow()[1]
const retainedBeforeSwap = fake.retained.length
face.swapPanes(firstPane.id, secondPane.id)
check('swap trades the pane Sessions',
  panesNow()[0].s === secondPane.s && panesNow()[1].s === firstPane.s,
  panesNow().map((pane) => pane.s).join(','))
check('swap does not re-retain', fake.retained.length === retainedBeforeSwap, String(fake.retained.length))

const closingPane = panesNow()[3]
const closingSession = closingPane.s
face.closePane(closingPane.id)
check('closing a pane drops its reference', snapshot().refs.size === 3, String(snapshot().refs.size))
check('closing a pane releases exactly that reference',
  fake.released.join(',') === String(closingSession), fake.released.join(','))
// The in-memory tree keeps the slot so the surviving pane is not remounted; the
// persisted projection must not.
check('the in-memory tree keeps the closed pane slot', hasDeadChild(snapshot().root))
flushTimers()
const persistedTree = storedLayout()
check('a persisted tree collapses the closed pane',
  persistedTree !== null && !hasDeadChild(persistedTree.root))
face.setRatio(snapshot().root.id, 0.9)
check('a divider ratio is clamped', snapshot().root.r <= 0.88, String(snapshot().root.r))

console.log('\nnavigation adoption')
const beforeClosedAdopt = panesNow().map((pane) => pane.s).join(',')
fake.pressFixed('KeyS')
check('the close is deferred until the column can be parked', snapshot().open === true)
flushFrames()
check('Ctrl+Alt+S closes the overlay', snapshot().open === false)
check('closing parks and restores the column',
  fake.events.indexOf('panel:dsh-split-void') !== -1
  && fake.events[fake.events.length - 1] === 'panel:null',
  fake.events.join(','))
fake.setCurrent('s5')
check('a closed overlay never adopts',
  panesNow().map((pane) => pane.s).join(',') === beforeClosedAdopt,
  panesNow().map((pane) => pane.s).join(','))

fake.pressFixed('KeyS')
check('Ctrl+Alt+S reopens the overlay', snapshot().open === true)
const adopted = fake.retained.length
// Reopening adopts what the user was reading: the overlay covers the native conversation, so a
// pane has to stand in for it — the navigation below is therefore already on screen.
check('reopening adopts the Session the user left on',
  panesNow().some((pane) => pane.s === 's5'), panesNow().map((pane) => pane.s).join(','))
fake.setCurrent('s5')
check('the focused pane shows the navigated Session',
  panesNow().some((pane) => pane.s === 's5'),
  panesNow().map((pane) => pane.s).join(','))
check('a repeat navigation retains nothing extra', fake.retained.length === adopted, String(fake.retained.length))
check('no Session is shown twice',
  new Set(panesNow().map((pane) => pane.s)).size === panesNow().length)
const elsewhere = panesNow().find((pane) => pane.s !== null && pane.id !== snapshot().focus)
fake.setCurrent(elsewhere.s)
check('navigating to an on-screen Session focuses its pane',
  snapshot().focus === elsewhere.id, String(snapshot().focus) + ' vs ' + elsewhere.id)

console.log('\ncomposer binding handoff')
storage.clear()
const handoff = createFakeContext()
exportsObject.apply(handoff.ctx)
const handoffFace = handoff.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const handoffMenu = handoff.slots.filter((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')[0].options.inject()
handoff.setList({ phase: 'ready', ids: ['s1', 's2', 's3'], byId: { s1: {}, s2: {}, s3: {} } })
handoff.setCurrent('s1')
handoffMenu.run('s2')
const handoffPanes = () => listOf(handoffFace.hooks.split.getSnapshot().root)
const paneOfS1 = handoffPanes().find((pane) => pane.s === 's1')
const paneOfS2 = handoffPanes().find((pane) => pane.s === 's2')
const gensFor = (paneId) => handoffFace.hooks.split.getSnapshot().gens.get(paneId) ?? 0
check('no pane is remounted before a navigation', gensFor(paneOfS1.id) === 0 && gensFor(paneOfS2.id) === 0)
// The native navigation lands on a Session a pane already shows: that pane must
// remount so its composer takes the shared editor back.
handoff.setCurrent('s1')
check('the pane showing the navigated Session is remounted', gensFor(paneOfS1.id) === 1, String(gensFor(paneOfS1.id)))
check('a pane not showing it is left alone', gensFor(paneOfS2.id) === 0, String(gensFor(paneOfS2.id)))
// A Sidebar click onto a Session that is not on screen still fills the focused pane.
handoff.setCurrent('s3')
check('a Sidebar click is adopted into a pane',
  handoffPanes().some((pane) => pane.s === 's3'),
  handoffPanes().map((pane) => pane.s).join(','))
check('clicking a pane never navigates', handoff.events.every((entry) => !entry.startsWith('open:')))

console.log('\nright sidebar toggle')
face.toggleRightbar()
check('the toggle goes through the native service', fake.toggles.length === 1, String(fake.toggles.length))

console.log('\nwindow shortcuts')
const beforeShortcutClose = panesNow().length
fake.pressFixed('KeyW')
check('Ctrl+Alt+W closes the focused pane',
  panesNow().length === beforeShortcutClose - 1, String(panesNow().length))
flushFrames()
fake.pressFixed('Digit1')
check('Ctrl+Alt+1 focuses a pane', snapshot().focus === panesNow()[0].id, String(snapshot().focus))

console.log('\ncollapsing to one pane ends the split view')
while (panesNow().length > 1) face.closePane(panesNow()[panesNow().length - 1].id)
flushFrames()
check('one pane left', panesNow().length === 1)
check('the overlay closed for the single window', snapshot().open === false)
check('the column was restored', fake.events[fake.events.length - 1] === 'panel:null',
  fake.events.slice(-3).join(','))

console.log('\nteardown repair')
const open = createFakeContext()
exportsObject.apply(open.ctx)
const openFace = open.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const openMenu = open.slots.filter((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')[0].options.inject()
open.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
open.setCurrent('s1')
openMenu.run('s2')
check('the overlay is open before teardown', openFace.hooks.split.getSnapshot().open === true)
open.disposeAll()
check('teardown parks the covered column',
  open.events.indexOf('panel:dsh-split-void') !== -1, open.events.join(','))
check('teardown releases every reference', open.released.length === 2, open.released.join(','))
check('references balance after teardown',
  open.retained.length === open.released.length, open.retained.length + ' retained / ' + open.released.length + ' released')
flushTimers()
check('teardown hands the column back', open.events[open.events.length - 1] === 'panel:null',
  open.events.slice(-3).join(','))

console.log('\npersistence')
flushTimers()
const stored = storedLayout() ?? {}
check('layout is persisted with a version', stored.v === 1)
check('the overlay state is not persisted', stored.open === undefined)
check('a burst of state changes writes once', timers.length === 0, String(timers.length))

console.log('\nmaterialize on restore')
storage.clear()
storage.set('dsh.split.v1', JSON.stringify({
  v: 1,
  focus: 'pane-x',
  root: {
    t: 's', id: 'split-x', dir: 'row', r: 0.4,
    a: { t: 'p', id: 'pane-x', s: 's1' },
    b: { t: 'p', id: 'pane-y', s: 's9' },
  },
}))
const restored = createFakeContext()
exportsObject.apply(restored.ctx)
const restoredFace = restored.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
restored.setList({ phase: 'ready', ids: ['s1'], byId: { s1: {} } })
check('restored Session is retained', restored.retained.some((entry) => entry.sessionId === 's1'))
check('a retain that republishes the list is not duplicated',
  restored.retained.length === 1, restored.retained.map((entry) => entry.sessionId).join(','))
check('unknown restored Session is left to the picker', !restored.retained.some((entry) => entry.sessionId === 's9'))
// A Session that is not in the catalogue is not coming back: keeping its id on the pane would
// persist a ghost forever and keep the picker filtering that row out.
const restoredPanes = listOf(restoredFace.hooks.split.getSnapshot().root)
check('the ghost Session id is cleared from the pane',
  !restoredPanes.some((pane) => pane.s === 's9'), restoredPanes.map((pane) => pane.s).join(','))
flushTimers()
check('and it is not persisted either',
  !String(storage.get('dsh.split.v1')).includes('s9'), String(storage.get('dsh.split.v1')))
check('restored ratio survives', restoredFace.hooks.split.getSnapshot().root.r === 0.4)
check('a restored layout starts closed', restoredFace.hooks.split.getSnapshot().open === false)

console.log('\nstored layout bounds')
storage.clear()
storage.set('dsh.split.v1', JSON.stringify({
  v: 1,
  focus: 'p9',
  // Six panes, one Session repeated: neither is reachable through this plugin's
  // own operations, so both must be bounded on the way in from storage.
  root: [1, 2, 3, 4, 5, 6].reduceRight((right, index) => ({
    t: 's',
    id: 'sp' + index,
    dir: 'row',
    r: 0.5,
    a: { t: 'p', id: 'p' + index, s: ['s1', 's2', 's1', 's4', 's5', 's6'][index - 1] },
    b: right,
  }), null),
}))
const bounded = createFakeContext()
exportsObject.apply(bounded.ctx)
const boundedFace = bounded.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
bounded.setList({ phase: 'ready', ids: ['s1', 's2', 's4'], byId: { s1: {}, s2: {}, s4: {} } })
const boundedPanes = listOf(boundedFace.hooks.split.getSnapshot().root)
check('a stored tree is capped at the pane ceiling', boundedPanes.length === 4, String(boundedPanes.length))
check('a repeated Session is cleared on the way in',
  boundedPanes.map((pane) => pane.s).join(',') === 's1,s2,,s4',
  boundedPanes.map((pane) => pane.s).join(','))
check('the cleared pane holds no reference', boundedFace.hooks.split.getSnapshot().refs.size === 3,
  String(boundedFace.hooks.split.getSnapshot().refs.size))
check('an unknown focus falls back to a pane',
  boundedPanes.some((pane) => pane.id === boundedFace.hooks.split.getSnapshot().focus),
  String(boundedFace.hooks.split.getSnapshot().focus))

console.log('\nrequest inside the parked frame')
storage.clear()
const race = createFakeContext()
exportsObject.apply(race.ctx)
const raceFace = race.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const raceMenu = race.slots.filter((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')[0].options.inject()
race.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
race.setCurrent('s1')
raceMenu.run('s2')
race.pressFixed('KeyS')
check('the column is parked while the restore is pending',
  race.getActive() === 'dsh-split-void', String(race.getActive()))
race.pressFixed('Digit1')
flushFrames()
check('a request inside that frame keeps the overlay open',
  raceFace.hooks.split.getSnapshot().open === true)
check('the column is handed back either way', race.getActive() === null, String(race.getActive()))
const raceGens = Array.from(raceFace.hooks.split.getSnapshot().gens.values())
check('the panes re-take their composer editors after the column returns',
  raceGens.length === 2 && raceGens.every((generation) => generation === 1), JSON.stringify(raceGens))

console.log('\nclosing returns the column to the panel it came from')
storage.clear()
const panels = createFakeContext()
exportsObject.apply(panels.ctx)
const panelsMenu = panels.slots.filter((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')[0].options.inject()
panels.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
panels.setCurrent('s1')
panels.setActive('plugins')
panelsMenu.run('s2')
check('opening leaves another panel selected', panels.getActive() === 'plugins', String(panels.getActive()))
panels.pressFixed('KeyS')
flushFrames()
check('closing returns to that panel', panels.getActive() === 'plugins', String(panels.getActive()))

console.log('\nsplitting the Session you are looking at')
storage.clear()
const own = createFakeContext()
exportsObject.apply(own.ctx)
const ownFace = own.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const ownMenu = own.slots.find((entry) => entry.options.id === 'dsh-split.right').options.inject()
own.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
own.setCurrent('s1')
check('the menu action succeeds', ownMenu.run('s1') === true)
const ownSnapshot = ownFace.hooks.split.getSnapshot()
const ownPanes = listOf(ownSnapshot.root)
const ownFocus = ownPanes.find((pane) => pane.id === ownSnapshot.focus)
check('the Session the user was watching stays in the anchor pane',
  ownPanes[0].s === 's1', ownPanes.map((pane) => pane.s).join(','))
// A split must end with two real conversations: the new pane takes the most recent Session that
// is not on screen yet. A pane that only asks the user to choose is never the result of a split.
check('the new pane is filled with the most recent other Session',
  ownFocus !== undefined && ownFocus.id !== ownPanes[0].id && ownFocus.s === 's2',
  ownPanes.map((pane) => pane.id + ':' + pane.s).join(' '))
check('both Sessions are retained once each', own.retained.length === 2, String(own.retained.length))
// A later navigation onto a Session that is already on screen focuses its pane instead.
own.setCurrent('s2')
check('a later navigation focuses the pane that already shows it',
  listOf(ownFace.hooks.split.getSnapshot().root).map((pane) => pane.s).join(',') === 's1,s2'
  && ownFace.hooks.split.getSnapshot().focus === ownPanes[1].id,
  listOf(ownFace.hooks.split.getSnapshot().root).map((pane) => pane.s).join(','))

console.log('\nwindow chords while the split view is closed')
const closed = createFakeContext()
exportsObject.apply(closed.ctx)
const closedFace = closed.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const closedMenu = closed.slots.filter((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')[0].options.inject()
closed.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
closed.setCurrent('s1')
closedMenu.run('s2')
closed.pressFixed('KeyS')
flushFrames()
const closedPanes = listOf(closedFace.hooks.split.getSnapshot().root).length
const closedEvents = closed.events.length
closed.pressFixed('KeyW')
flushFrames()
check('Ctrl+Alt+W neither opens the view nor closes a hidden pane',
  closedFace.hooks.split.getSnapshot().open === false
  && listOf(closedFace.hooks.split.getSnapshot().root).length === closedPanes
  && closed.events.length === closedEvents,
  String(closed.getActive()))

console.log('\na single pane is not a split view')
const solo = createFakeContext()
exportsObject.apply(solo.ctx)
const soloFace = solo.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
solo.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
solo.setCurrent('s1')
solo.pressFixed('KeyS')
check('Ctrl+Alt+S does nothing with a single pane',
  soloFace.hooks.split.getSnapshot().open === false && solo.getActive() === null,
  String(solo.getActive()))

console.log('\na Session that leaves the catalogue')
storage.clear()
const gone = createFakeContext()
exportsObject.apply(gone.ctx)
const goneFace = gone.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const goneMenu = gone.slots.filter((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')[0].options.inject()
gone.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
gone.setCurrent('s1')
goneMenu.run('s2')
check('two panes hold Sessions', listOf(goneFace.hooks.split.getSnapshot().root).filter((pane) => pane.s !== null).length === 2)
gone.setList({ phase: 'ready', ids: ['s1'], byId: { s1: {} } })
const gonePanes = listOf(goneFace.hooks.split.getSnapshot().root)
check('the pane whose Session is gone is emptied', gonePanes.some((pane) => pane.s === null),
  gonePanes.map((pane) => pane.s).join(','))
check('its reference is released', goneFace.hooks.split.getSnapshot().refs.size === 1,
  String(goneFace.hooks.split.getSnapshot().refs.size))
gone.setList({ phase: 'pending', ids: [], byId: {} })
const afterPending = listOf(goneFace.hooks.split.getSnapshot().root)
check('a non-ready catalogue clears nothing', afterPending.some((pane) => pane.s === 's1'),
  afterPending.map((pane) => pane.s).join(','))

console.log('\npane conversation phases')
const paneComponent = fake.slots.find((entry) => entry.options.name === 'split.pane').component
/** Call the registered pane component with fake hooks and report the factory props. */
function paneFactoryProps(session, summary) {
  let seen = null
  paneComponent({
    sessionId: 's1',
    useSession: (select) => select(session),
    useConversation: (select) => select({ activeTargets: new Set() }),
    useSessions: (select) => select({ ids: ['s1'], byId: summary === undefined ? {} : { s1: summary } }),
    renderFactorySlot: (name, values) => { seen = { name, values }; return null },
  })
  return seen
}
const settlingPane = paneFactoryProps({ blank: true, openState: 'loading', promptAttempted: false, running: false })
check('a loading Session renders the settling phase',
  settlingPane.name === 'conversation.content' && settlingPane.values.phase === 'settling'
  && settlingPane.values.variant === 'embedded' && settlingPane.values.hero === false,
  JSON.stringify(settlingPane === null ? null : settlingPane.values))
const heroPane = paneFactoryProps({ blank: true, openState: 'open', promptAttempted: false, running: false })
check('a blank open Session renders the hero',
  heroPane.values.phase === 'hero' && heroPane.values.hero === true, JSON.stringify(heroPane.values))
const blankSummaryPane = paneFactoryProps({ blank: true, openState: 'loading', promptAttempted: false, running: false }, { blank: true })
check('a blank summary outranks the loading phase',
  blankSummaryPane.values.phase === 'hero', JSON.stringify(blankSummaryPane.values))
const runningPane = paneFactoryProps({ blank: false, openState: 'open', promptAttempted: false, running: true })
check('a running Session renders the active phase',
  runningPane.values.phase === 'active' && runningPane.values.hero === false, JSON.stringify(runningPane.values))
const attemptedPane = paneFactoryProps({ blank: true, openState: 'open', promptAttempted: true, running: false })
check('an attempted prompt is not a blank Session',
  attemptedPane.values.phase === 'active' && attemptedPane.values.hero === false,
  JSON.stringify(attemptedPane.values))
const unresolvedPane = paneFactoryProps(undefined, undefined)
check('an unresolved Session renders the settling phase', unresolvedPane.values.phase === 'settling')

console.log('\noverlay render tier')
storage.clear()
const tree = createFakeContext()
exportsObject.apply(tree.ctx)
const overlayEntry = tree.slots.find((entry) => entry.options.name === 'shell.overlay')
const treeFace = overlayEntry.options.inject()
const treeMenu = tree.slots.filter((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')[0].options.inject()
const CATALOGUE = { ids: ['s1', 's2', 's3'], byId: { s1: {}, s2: {}, s3: {} } }
tree.setList({ phase: 'ready', ...CATALOGUE })
tree.setCurrent('s1')

/**
 * Walk a recorded tree, expanding function components the way the renderer would.
 *
 * The stub records `createElement` calls, so a component's own output is only visible
 * once it is called; this is that call, without React.
 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node.type === 'function') {
    visit(node)
    walk(node.type(node.props), visit)
    return
  }
  if (node.type !== undefined) visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** Every element of one type in a subtree. */
function elementsOf(node, type) {
  const found = []
  walk(node, (child) => { if (child.type === type) found.push(child) })
  return found
}

/** The pane sections of a recorded overlay tree. */
function sectionsOf(node) {
  return elementsOf(node, 'section')
}

/** Stand-in for the framework's SessionProvider seat; it renders its children through. */
const SessionProviderMarker = function SessionProviderMarker(props) { return props.children ?? null }

/** Render the overlay once, with scripted local state (see stateScript). */
function renderOverlay(script) {
  stateScript = script ?? []
  stateUsed = new Set()
  return overlayEntry.component({
    useSplit: (select) => select(treeFace.hooks.split.getSnapshot()),
    closePane: treeFace.closePane,
    assignSession: treeFace.assignSession,
    focusPane: treeFace.focusPane,
    swapPanes: treeFace.swapPanes,
    setRatio: treeFace.setRatio,
    toggleRightbar: treeFace.toggleRightbar,
    isOpen: treeFace.isOpen,
    renderSlot: (name, ownerProps) => ({ type: 'slot:' + name, props: ownerProps, children: [] }),
    SessionProvider: SessionProviderMarker,
    useSessions: (select) => select(CATALOGUE),
    t: (key) => key,
  })
}

check('a closed overlay renders nothing', renderOverlay() === null)
treeMenu.run('s2')
const shell = renderOverlay()
check('the open overlay renders one section per pane', sectionsOf(shell).length === 2, String(sectionsOf(shell).length))
check('the first frame carries chrome but no conversation',
  elementsOf(shell, SessionProviderMarker).length === 0 && sectionsOf(shell).length === 2)
// `shell` is allowed to be null here — that is what the two checks above report — so the
// reads below go through a stand-in: a harness that dies on the first regression hides
// every check after it, including the whole interaction tier.
const shellNode = shell ?? { props: {}, type: 'missing' }
check('the stage counter is published for debugging', shellNode.props['data-split-staged'] === '0',
  String(shellNode.props['data-split-staged']))
check('the overlay fences file drops at its root',
  typeof shellNode.props.onDrop === 'function' && typeof shellNode.props.onDragOver === 'function')

const focusPaneId = shellNode.props['data-split-focus']
const staged = renderOverlay([1])
const sections = sectionsOf(staged)
const stagedNode = staged ?? { props: {}, type: 'missing' }
const focused = sections.filter((pane) => pane.props['data-split-pane'] === focusPaneId)
const others = sections.filter((pane) => pane.props['data-split-pane'] !== focusPaneId)
check('the focused pane stages first',
  stagedNode.props['data-split-staged'] === '1'
  && focused.length === 1 && elementsOf(focused[0], SessionProviderMarker).length === 1
  && others.length === 1 && elementsOf(others[0], SessionProviderMarker).length === 0,
  String(stagedNode.props['data-split-staged']) + ' focus=' + String(focusPaneId))
check('each pane offers the right-column toggle and its own close',
  sections.every((pane) => elementsOf(pane, PrimitivesStub.Tooltip).length === 2))
check('a pane section reports its Session',
  sections.some((pane) => pane.props['data-split-session'] === 's1')
  && sections.some((pane) => pane.props['data-split-session'] === 's2'),
  sections.map((pane) => pane.props['data-split-session']).join(','))
const stagedBoth = renderOverlay([2])
const providers = elementsOf(stagedBoth, SessionProviderMarker)
check('every staged pane mounts its conversation', providers.length === 2, String(providers.length))
check('the provider key carries the binding generation',
  providers.length === 2 && providers.every((provider) => /^s[12]#\d+$/.test(String(provider.props.key))),
  providers.map((provider) => provider.props.key).join(','))
check('the pane body renders the session-scoped slot',
  elementsOf(stagedBoth, 'slot:split.pane').length === 2,
  String(elementsOf(stagedBoth, 'slot:split.pane').length))

// A pane whose chrome and body disagree must render an honest empty pane, not another
// Session's transcript under this Session's title (the failure the guard exists for).
const paneNodes = []
walk(stagedBoth, (node) => {
  if (node.props !== undefined && node.props.pane !== undefined && node.props.generation !== undefined) paneNodes.push(node)
})
// Same reason as `shellNode`: with no pane to invoke, the stand-in reports the failure
// through the check below instead of throwing out of the middle of the run.
const paneNode = paneNodes[0] ?? { type: () => null, props: {} }
const mismatched = paneNode.type({
  ...paneNode.props,
  reference: { sessionId: 'not-this-pane' },
  staged: true,
})
check('a pane/session mismatch renders no conversation',
  paneNodes.length === 2 && elementsOf(mismatched, SessionProviderMarker).length === 0
  && mismatched.type === 'section',
  String(paneNodes.length))
// The guard warns from an effect, so the harness has to run the effects it recorded.
pendingEffects.length = 0
const warnings = []
const realWarn = console.warn
console.warn = (...args) => { warnings.push(args.join(' ')) }
paneNode.type({ ...paneNode.props, reference: { sessionId: 'not-this-pane' }, staged: true })
flushEffects()
console.warn = realWarn
check('the mismatch guard reports once, from an effect',
  warnings.filter((line) => line.includes('pane/session mismatch')).length === 1,
  warnings.join(' | '))

console.log('\nthe centre-column hook')
domCenter.attributes.clear()
const hook = createFakeContext()
exportsObject.apply(hook.ctx)
check('startup marks the column for the window styles',
  domCenter.hasAttribute('data-dsh-center') && !domCenter.hasAttribute('data-dsh-covered'),
  JSON.stringify([...domCenter.attributes]))
hook.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
hook.setCurrent('s1')
hook.slots.find((entry) => entry.options.id === 'dsh-split.right').options.inject().run('s2')
check('the covered column is inert and marked covered',
  domCenter.hasAttribute('data-dsh-covered') && domCenter.hasAttribute('inert')
  && domCenter.getAttribute('aria-hidden') === 'true',
  JSON.stringify([...domCenter.attributes]))
hook.pressFixed('KeyS')
flushFrames()
check('closing keeps the hook and drops the covered state',
  domCenter.hasAttribute('data-dsh-center') && !domCenter.hasAttribute('data-dsh-covered')
  && !domCenter.hasAttribute('inert') && !domCenter.hasAttribute('aria-hidden'),
  JSON.stringify([...domCenter.attributes]))
hook.disposeAll()
check('teardown leaves the frame as it was found', domCenter.attributes.size === 0,
  JSON.stringify([...domCenter.attributes]))

console.log('\nsplitting beside a restored single window')
storage.clear()
storage.set('dsh.split.v1', JSON.stringify({
  v: 1, focus: 'pane-a', root: { t: 'p', id: 'pane-a', s: 's1' },
}))
const warm = createFakeContext()
exportsObject.apply(warm.ctx)
const warmFace = warm.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const warmMenu = warm.slots.find((entry) => entry.options.id === 'dsh-split.right').options.inject()
warm.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
warm.setCurrent('s1')
// After a restart the single pane already shows the current Session — the most common state
// there is. The menu must still split, and the new pane takes the most recent Session that is not
// on screen: a split ends with two real conversations, never with a question.
check('the menu splits beside a single restored window',
  warmMenu.run('s1') === true
  && listOf(warmFace.hooks.split.getSnapshot().root).length === 2
  && warmFace.hooks.split.getSnapshot().open === true,
  String(listOf(warmFace.hooks.split.getSnapshot().root).length))
check('and the Session the user was watching stays put',
  listOf(warmFace.hooks.split.getSnapshot().root)[0].s === 's1')
check('and the new pane shows the next Session',
  listOf(warmFace.hooks.split.getSnapshot().root)[1].s === 's2',
  listOf(warmFace.hooks.split.getSnapshot().root).map((pane) => pane.s).join(','))

console.log('\nthe stylesheet lifecycle')
const styleElements = () => createdElements.filter((element) => element.tag === 'style')
const sheetsBefore = styleElements().length
const styled = createFakeContext()
exportsObject.apply(styled.ctx)
const ownSheets = styleElements().slice(sheetsBefore)
check('one stylesheet per apply', ownSheets.length === 1, String(ownSheets.length))
styled.disposeAll()
check('teardown removes the stylesheet', ownSheets[0].removed === true)

console.log('\nwindow token scope')
// The design tokens these reference are declared on `body` (ui-theme/design-platform.css:4
// light, :85 dark), and a custom property's var() references are substituted on the element
// that declares it. Declaring the window tokens on `:root` therefore invalidates every one
// of them on `html`, and each rule silently falls back — which showed up as transparent
// panes (content bleeding together) and a system-colour backdrop, with nothing in the
// console. These three checks are what makes that failure loud instead.
const sheet = styleElements().length === 0 ? '' : styleElements()[styleElements().length - 1].textContent
const cssOpen = (sheet.match(/\{/g) ?? []).length
const cssClose = (sheet.match(/\}/g) ?? []).length
check('the injected sheet is brace-balanced', cssOpen === cssClose && cssOpen > 0, cssOpen + '/' + cssClose)
const cssNeedles = ['@keyframes dsh-split-in', '@keyframes dsh-split-out', '@keyframes dsh-split-pane-in', 'prefers-reduced-motion', 'animation: none', '--ds-transition-duration-slow', 'data-dsh-split-open']
check('the fades and their reduced-motion switch are present',
  cssNeedles.every((needle) => sheet.includes(needle)),
  cssNeedles.filter((needle) => !sheet.includes(needle)).join(','))
check('the window tokens are declared where the theme tokens are',
  sheet.includes('body {') && !sheet.includes(':root {'), sheet.slice(0, 40))
// The focused pane must stay *stronger* than a resting one. Raising the base window edge to l3
// once swallowed the focus state silently (its border was l2), so the relationship between the
// two is asserted instead of assumed.
const borderLevel = (source, pattern) => {
  const found = source.match(pattern)
  return found === null ? -1 : Number(found[1])
}
const focusLevel = borderLevel(sheet, /dsh-split-pane\.is-focused \{[^}]*border-color: var\(--dsw-alias-border-l(\d)\)/)
const baseLevel = borderLevel(sheet, /--dsh-split-border: 0\.5px solid var\(--dsw-alias-border-l(\d)\)/)
check('the focused pane edge is at least as strong as the resting one',
  focusLevel >= baseLevel && baseLevel > 0, 'focus l' + focusLevel + ' / base l' + baseLevel)
check('the focus state is a border step, not a coloured ring', !/outline:/.test(sheet))
const TOKENS = ['inset', 'gap', 'radius', 'border', 'surface', 'backdrop', 'duration', 'ink-mix']
const bare = TOKENS.filter((token) => sheet.includes('var(--dsh-split-' + token + ')'))
check('no window token is read without a fallback', bare.length === 0, bare.join(','))
const weak = TOKENS.filter((token) => sheet.includes('var(--dsh-split-' + token + ', Canvas)'))
check('a token falls back to a design token before a system colour', weak.length === 0, weak.join(','))

console.log('\nrestoring two known Sessions (re-entrant retain)')
storage.clear()
// Drain earlier contexts' pending timers first, so the write counter below belongs to this
// section only (the harness keeps one global timer queue).
flushTimers()
writeCount = 0
storage.set('dsh.split.v1', JSON.stringify({
  v: 1,
  focus: 'pane-a',
  root: {
    t: 's', id: 'split-a', dir: 'row', r: 0.5,
    a: { t: 'p', id: 'pane-a', s: 's1' },
    b: { t: 'p', id: 'pane-b', s: 's2' },
  },
}))
const pair = createFakeContext()
exportsObject.apply(pair.ctx)
const pairFace = pair.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
pair.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
// `retain` republishes the list synchronously, so the pass that fills the panes re-enters
// itself. Each pane must still be retained exactly once: a duplicate reference is held by
// nobody, so it is never released and its Session never retires.
check('each restored pane is retained exactly once',
  pair.retained.length === 2, pair.retained.map((entry) => entry.sessionId).join(','))
check('each restored pane holds one reference',
  pairFace.hooks.split.getSnapshot().refs.size === 2,
  String(pairFace.hooks.split.getSnapshot().refs.size))
for (const pane of listOf(pairFace.hooks.split.getSnapshot().root)) pairFace.focusPane(pane.id)
check('a burst of state changes writes nothing yet', writeCount === 0, String(writeCount))
flushTimers()
check('the burst ends in one coalesced write', writeCount === 1, String(writeCount))
check('the coalesced write matches the layout',
  JSON.parse(storage.get('dsh.split.v1')).focus === pairFace.hooks.split.getSnapshot().focus)

console.log('\nsplitting downward')
storage.clear()
const down = createFakeContext()
exportsObject.apply(down.ctx)
const downFace = down.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const downMenu = down.slots.find((entry) => entry.options.id === 'dsh-split.down').options.inject()
down.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
down.setCurrent('s1')
check('the downward entry opens a column split',
  downMenu.run('s2') === true
  && downFace.hooks.split.getSnapshot().root.dir === 'col'
  && listOf(downFace.hooks.split.getSnapshot().root).length === 2,
  String(downFace.hooks.split.getSnapshot().root.dir))

console.log('\na late sequence after teardown stays silent')
domCenter.attributes.clear()
const late = createFakeContext()
exportsObject.apply(late.ctx)
const lateFace = late.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const lateMenu = late.slots.find((entry) => entry.options.id === 'dsh-split.right').options.inject()
late.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
late.setCurrent('s1')
lateMenu.run('s2')
late.pressFixed('KeyS')
check('the close is parked and pending', late.getActive() === 'dsh-split-void', String(late.getActive()))
late.disposeAll()
flushFrames()
flushTimers()
check('a disposed instance leaves the frame as it was found',
  domCenter.attributes.size === 0, JSON.stringify([...domCenter.attributes]))
check('but it still hands the parked column back', late.getActive() === null, String(late.getActive()))

console.log('\na reloaded instance keeps the centre-column marker')
domCenter.attributes.clear()
const firstRun = createFakeContext()
exportsObject.apply(firstRun.ctx)
const firstMenu = firstRun.slots.find((entry) => entry.options.id === 'dsh-split.right').options.inject()
firstRun.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
firstRun.setCurrent('s1')
firstMenu.run('s2')
firstRun.disposeAll()
const secondRun = createFakeContext()
exportsObject.apply(secondRun.ctx)
check('the reloaded instance publishes the marker',
  domCenter.hasAttribute('data-dsh-center') && !domCenter.hasAttribute('data-dsh-covered'),
  JSON.stringify([...domCenter.attributes]))
flushFrames()
flushTimers()
check('the disposed instance does not strip it',
  domCenter.hasAttribute('data-dsh-center') && !domCenter.hasAttribute('data-dsh-covered'),
  JSON.stringify([...domCenter.attributes]))

/* ---------------------------------------------------------------- *
 * Stateful render tier
 *
 * Everything above this line calls components directly and inspects the element
 * tree they return — which cannot see an effect run, a class painted onto a
 * committed node, a listener released, or a memo boundary holding. These sections
 * mount the shipped overlay through the renderer above and assert on the DOM it
 * produces, so an implementation that never advances its staged mount, never
 * measures the column, never paints focus, or never releases a listener fails.
 * ---------------------------------------------------------------- */

/** Transcript render counters: the memo boundary is only real if these hold still. */
const transcript = { provider: 0, slot: 0 }

/** The pane's `SessionProvider` seat: renders through, and counts its own render. */
function CountingProvider(props) {
  transcript.provider += 1
  return props.children ?? null
}

/** The pane's conversation body, as a mounted element the checks can query. */
function TranscriptProbe(props) {
  transcript.slot += 1
  return ReactStub.createElement('div', {
    className: 'dsh-split-transcript',
    'data-pane': props.paneId ?? '',
    'data-slot': props.name,
  })
}

/** `renderSlot` for the session-scoped child: mounts the probe where the Factory would. */
function tierRenderSlot(name, values) {
  const paneId = values === undefined || values === null ? null : values.paneId
  return ReactStub.createElement(TranscriptProbe, { key: name + ':' + String(paneId), name, paneId })
}

/**
 * Mount the shipped overlay for a fresh two-pane context.
 *
 * The injected face is read once, the way the shell caches an injection result, so
 * the callbacks the panes receive keep their identity across renders. Without that
 * every drag frame would hand each pane a new prop object and the memo boundary
 * could not hold — which is exactly what the paint checks below measure.
 */
function tierMount(options) {
  storage.clear()
  const context = createFakeContext()
  exportsObject.apply(context.ctx)
  const menu = context.slots.find((entry) => entry.options.id === 'dsh-split.right').options.inject()
  const ids = (options ?? {}).ids ?? ['s1', 's2']
  const byId = {}
  for (const id of ids) byId[id] = { displayTitle: id.toUpperCase() }
  context.setList({ phase: 'ready', ids, byId })
  context.setCurrent('s1')
  // `own` splits with the Session the user is watching; a split ends with two real conversations
  // and focused — the state the picker exists for.
  menu.run((options ?? {}).own === true ? 's1' : 's2')
  const entry = context.slots.find((item) => item.options.name === 'shell.overlay')
  const face = entry.options.inject()
  const store = face.hooks.split
  const props = {
    useSplit: (select) => ReactStub.useSyncExternalStore(store.subscribe, () => select(store.getSnapshot())),
    closePane: face.closePane,
    assignSession: face.assignSession,
    focusPane: face.focusPane,
    swapPanes: face.swapPanes,
    setRatio: face.setRatio,
    toggleRightbar: face.toggleRightbar,
    isOpen: face.isOpen,
    renderSlot: tierRenderSlot,
    SessionProvider: CountingProvider,
    useSessions: (select) => select({ ids, byId }),
    t: (key) => key,
  }
  const tree = createRoot(domLayer)
  tree.render(ReactStub.createElement(entry.component, props))
  return { context, menu, entry, face, props, store, tree }
}

/** The mounted overlay root, or null while the view is closed. */
function tierRoot() {
  return domLayer.querySelector('[data-split-root]')
}

/** The mounted pane sections, in document order. */
function tierPanes() {
  const root = tierRoot()
  return root === null ? [] : root.querySelectorAll('[data-split-pane]')
}

/** One pane section by the Session it shows. */
function tierPaneOf(sessionId) {
  return tierPanes().find((pane) => pane.getAttribute('data-split-session') === sessionId) ?? null
}

/** The published stage counter, or null while nothing is mounted. */
function tierStaged() {
  const root = tierRoot()
  return root === null ? null : root.getAttribute('data-split-staged')
}

/** Mounted conversation bodies. */
function tierTranscripts() {
  const root = tierRoot()
  return root === null ? [] : root.querySelectorAll('.dsh-split-transcript')
}

/** Stage every pane through the effects, frames and timers that get it there. */
function tierStageAll() {
  for (let round = 0; round < 8; round += 1) {
    if (tierPanes().length > 0 && tierTranscripts().length >= tierPanes().length) break
    flushEffects()
    flushFrames()
    flushTimers()
  }
  flushEffects()
}

/** Run the queued timers of one delay, oldest first, honouring cancellation. */
function flushTimersOf(delay) {
  const queued = []
  for (let index = timers.length - 1; index >= 0; index -= 1) {
    if (timers[index].delay !== delay) continue
    queued.unshift(timers.splice(index, 1)[0])
  }
  for (const entry of queued) if (!entry.cancelled) entry.callback()
}

/*
 * A missing element must fail a check, not crash the run: every accessor below
 * tolerates a node that the render never produced, so a mutation that stops the
 * overlay from mounting is reported as failures instead of a stack trace.
 */

/** Attribute of a possibly-absent node. */
function hasAttrOf(node, name) {
  if (node === null || node === undefined) return false
  return node.hasAttribute(name)
}

/** Attribute names of a possibly-absent node. */
function attrsOf(node) {
  return node === null || node === undefined ? [] : Array.from(node.attributes.keys())
}

function hasClassOf(node, name) {
  if (node === null || node === undefined) return false
  return node.classList.contains(name)
}

function classesOf(node) {
  return node === null || node === undefined ? '(no element)' : node.className
}

function styleOf(node) {
  return node === null || node === undefined ? {} : node.style
}

/** Text content of a possibly-absent node. */
function textOf(node) {
  return node === null || node === undefined ? '(no element)' : node.textContent
}

function queryIn(node, selector) {
  return node === null || node === undefined ? null : node.querySelector(selector)
}

function descendantsIn(node, selector) {
  return node === null || node === undefined ? [] : node.querySelectorAll(selector)
}

function dispatchTo(node, event) {
  if (node !== null && node !== undefined) node.dispatchEvent(event)
}

/** Pointer capture of a possibly-absent node. */
function captureOf(node, pointerId) {
  if (node === null || node === undefined) return false
  return node.hasPointerCapture(pointerId)
}

/** `flex` of one cell of a split, or a marker string when the cell is missing. */
function flexOf(cells, index) {
  if (cells.length <= index) return '(missing cell)'
  return cells[index].style.flex
}

console.log('\nstateful tier: the staged mount advances one pane per frame')
const stagedMount = tierMount()
transcript.provider = 0
transcript.slot = 0
check('the overlay mounts its chrome for both panes',
  tierRoot() !== null && tierPanes().length === 2, String(tierPanes().length))
check('the first commit stages no pane',
  tierStaged() === '0' && tierTranscripts().length === 0,
  String(tierStaged()) + '/' + String(tierTranscripts().length))
const framesBefore = frames.length
const timersBefore = timers.length
flushEffects()
check('the staged effect arms one frame and one 250 ms fallback',
  frames.length - framesBefore === 1
  && timers.slice(timersBefore).filter((entry) => entry.delay === 250 && !entry.cancelled).length === 1,
  String(frames.length - framesBefore) + ' frames, '
  + String(timers.slice(timersBefore).filter((entry) => entry.delay === 250).length) + ' fallbacks')
flushFrames()
check('one frame stages exactly one pane',
  tierStaged() === '1' && tierTranscripts().length === 1,
  String(tierStaged()) + '/' + String(tierTranscripts().length))
const stagedFirst = tierPanes().filter((pane) => pane.querySelector('.dsh-split-transcript') !== null)
check('the staged pane is the focused one, not the leftmost',
  stagedFirst.length === 1
  && stagedFirst[0].getAttribute('data-split-pane') === stagedMount.face.hooks.split.getSnapshot().focus,
  stagedFirst.map((pane) => pane.getAttribute('data-split-pane')).join(','))
flushEffects()
flushFrames()
check('the next frame stages the pane that was left',
  tierStaged() === '2' && tierTranscripts().length === 2,
  String(tierStaged()) + '/' + String(tierTranscripts().length))
const hostsConversation = (sessionId) => {
  const pane = tierPaneOf(sessionId)
  return pane !== null
    && pane.querySelectorAll('.dsh-split-transcript').length === 1
    && pane.querySelector('.dsh-split-body') !== null
}
check('every staged pane hosts its conversation',
  hostsConversation('s1') && hostsConversation('s2'),
  tierPanes().map((pane) => pane.getAttribute('data-split-session')).join(','))
check('each pane mounted its transcript exactly once',
  transcript.slot === 2 && transcript.provider === 2,
  String(transcript.slot) + ' bodies, ' + String(transcript.provider) + ' providers')
flushEffects()
flushFrames()
check('staging stops at the pane count',
  tierStaged() === '2' && tierTranscripts().length === 2 && frames.length === 0,
  String(tierStaged()) + '/' + String(frames.length) + ' frames')
stagedMount.tree.unmount()

const pausedWindow = tierMount()
transcript.slot = 0
flushEffects()
flushTimersOf(250)
check('a paused window still stages through the timeout fallback',
  tierStaged() === '1' && tierTranscripts().length === 1,
  String(tierStaged()) + '/' + String(tierTranscripts().length))
flushFrames()
check('the frame that arrives late does not stage a second pane',
  tierStaged() === '1' && tierTranscripts().length === 1,
  String(tierStaged()) + '/' + String(tierTranscripts().length))
flushEffects()
flushTimersOf(250)
check('the next timeout finishes the staging',
  tierStaged() === '2' && tierTranscripts().length === 2,
  String(tierStaged()) + '/' + String(tierTranscripts().length))
pausedWindow.tree.unmount()

console.log('\nstateful tier: the overlay box follows the centre column')
domLayer.rect = { left: 0, top: 32, width: 1000, height: 700 }
domCenter.rect = { left: 240, top: 32, width: 600, height: 700 }
const resizeIdle = liveWindowListeners('resize')
const observersIdle = resizeObservers.length
const boxed = tierMount()
const boxNode = tierRoot()
const boxStyle = styleOf(boxNode)
check('the overlay writes the centre column box on commit',
  boxNode !== null && boxStyle.left === '240px' && boxStyle.top === '0px'
  && boxStyle.width === '600px' && boxStyle.height === '700px',
  boxNode === null ? 'no root' : JSON.stringify(boxStyle))
check('the frame carries the split marker that shortens its track slide',
  domFrame.hasAttribute('data-dsh-split-open') === true)
const boxObservers = resizeObservers.slice(observersIdle)
const boxObserver = boxObservers.length === 0 ? null : boxObservers[0]
check('it observes the column and the frame',
  boxObservers.length === 1 && boxObserver.targets.length === 2
  && boxObserver.targets.indexOf(domCenter) !== -1 && boxObserver.targets.indexOf(domFrame) !== -1,
  String(boxObservers.length) + ' observers, '
  + String(boxObserver === null ? 0 : boxObserver.targets.length) + ' targets')
check('and it listens for a window resize', liveWindowListeners('resize') === resizeIdle + 1,
  String(liveWindowListeners('resize')))
domCenter.rect = { left: 300, top: 40, width: 500, height: 640 }
triggerResizeObservers()
check('a ResizeObserver callback re-measures the box',
  boxStyle.left === '300px' && boxStyle.top === '8px'
  && boxStyle.width === '500px' && boxStyle.height === '640px',
  JSON.stringify(boxStyle))
domFrame.setAttribute('data-animating', '')
domCenter.rect = { left: 320, top: 40, width: 400, height: 640 }
triggerResizeObservers()
check('the panes hold their box while the frame animates its tracks',
  boxStyle.width === '500px' && boxStyle.left === '300px', JSON.stringify(boxStyle))
check('and the view dims to hide the settle',
  boxNode !== null && boxNode.hasAttribute('data-split-animating') === true)
triggerResizeObservers()
triggerResizeObservers()
check('the hold lasts the whole animation',
  boxStyle.width === '500px' && boxStyle.left === '300px', JSON.stringify(boxStyle))
flushTimers()
check('and settles on its own once the motion goes quiet',
  boxStyle.width === '400px' && boxStyle.left === '320px'
  && boxNode.hasAttribute('data-split-animating') === false, JSON.stringify(boxStyle))
domFrame.removeAttribute('data-animating')
check('the marker removal re-measures idempotently',
  boxStyle.width === '400px' && boxStyle.left === '320px', JSON.stringify(boxStyle))
domCenter.rect = { left: 20, top: 32, width: 700, height: 700 }
dispatchWindow('resize', domEvent('resize'))
check('a window resize re-measures too',
  boxStyle.left === '20px' && boxStyle.width === '700px',
  JSON.stringify(boxStyle))
// The layer spans the frame's padding box, which includes the Windows caption band: with
// no column to measure, the overlay has to stay clear of it rather than fall back to the
// whole layer, which would put the panes over the app's menu and window controls.
domFrame.removeChild(domLayer)
triggerResizeObservers()
check('with no column to measure it stays clear of the caption band',
  boxStyle.top === 'var(--dsh-windows-titlebar-height, 0px)', JSON.stringify(boxStyle))
domFrame.appendChild(domLayer)
domCenter.rect = { left: 20, top: 32, width: 700, height: 700 }
triggerResizeObservers()
check('and it measures again once the column is back',
  boxStyle.left === '20px' && boxStyle.top === '0px' && boxStyle.width === '700px',
  JSON.stringify(boxStyle))
boxed.tree.unmount()
check('unmount disconnects the observer and drops the listener',
  boxObserver !== null && boxObserver.disconnected === true && liveWindowListeners('resize') === resizeIdle,
  String(liveWindowListeners('resize')))

console.log('\nstateful tier: the split yields to a fullscreen right panel')
const yielding = tierMount()
const yieldNode = tierRoot()
const mutationsBefore = mutationObservers.length
check('a normal frame shows no yield marker', hasAttrOf(yieldNode, 'data-split-yield') === false,
  JSON.stringify(attrsOf(yieldNode)))
domFrame.setAttribute('data-rightbar-fullscreen', '')
check('an attribute no effect is watching yet paints nothing',
  hasAttrOf(yieldNode, 'data-split-yield') === false,
  JSON.stringify(attrsOf(yieldNode)))
flushEffects()
check('the effect syncs the marker on its first run',
  hasAttrOf(yieldNode, 'data-split-yield') === true,
  JSON.stringify(attrsOf(yieldNode)))
domFrame.removeAttribute('data-rightbar-fullscreen')
check('the marker is dropped when the panel shrinks back',
  hasAttrOf(yieldNode, 'data-split-yield') === false)
domFrame.setAttribute('data-rightbar-fullscreen', '')
check('a later attribute change still reaches the overlay',
  mutationObservers.length === mutationsBefore + 1
  && hasAttrOf(yieldNode, 'data-split-yield') === true,
  String(mutationObservers.length - mutationsBefore) + ' observers')
domFrame.removeAttribute('data-rightbar-fullscreen')
const yieldObservers = mutationObservers.slice(mutationsBefore)
yielding.tree.unmount()
check('the attribute observer is disconnected and unregistered',
  yieldObservers.length === 1 && yieldObservers.every((observer) => observer.disconnected)
  && domFrame.observers.length === 0,
  String(domFrame.observers.length) + ' still watching the frame')

console.log('\nstateful tier: focus and drag paint the DOM, not the panes')
domLayer.rect = null
domCenter.rect = null
const painting = tierMount()
transcript.provider = 0
transcript.slot = 0
tierStageAll()
check('both panes host a transcript before any interaction',
  tierTranscripts().length === 2 && transcript.slot === 2,
  String(tierTranscripts().length) + ' bodies, ' + String(transcript.slot) + ' body renders')
for (const pane of tierPanes()) {
  pane.rect = pane.getAttribute('data-split-session') === 's1'
    ? { left: 400, top: 0, width: 400, height: 600 }
    : { left: 0, top: 0, width: 400, height: 600 }
}
const paintSnapshot = painting.face.hooks.split.getSnapshot()
const paintPanes = listOf(paintSnapshot.root)
const otherPane = paintPanes.find((pane) => pane.id !== paintSnapshot.focus)
const focusedPane = paintPanes.find((pane) => pane.id === paintSnapshot.focus)
transcript.slot = 0
painting.face.focusPane(otherPane.id)
check('a focus move repaints the ring on the committed panes',
  hasClassOf(tierPaneOf(otherPane.s), 'is-focused')
  && hasClassOf(tierPaneOf(focusedPane.s), 'is-focused') === false,
  tierPanes().map((pane) => pane.getAttribute('data-split-session') + '[' + pane.className + ']').join(' '))
check('and re-renders no transcript', transcript.slot === 0, String(transcript.slot))
const clickedPane = tierPaneOf(focusedPane.s)
transcript.slot = 0
dispatchTo(clickedPane, domEvent('pointerdown', { button: 0, pointerId: 1, clientX: 410, clientY: 10 }))
check('clicking a pane moves the ring to that pane',
  hasClassOf(clickedPane, 'is-focused')
  && hasClassOf(tierPaneOf(otherPane.s), 'is-focused') === false,
  classesOf(clickedPane))
check('a pane click re-renders no transcript either', transcript.slot === 0, String(transcript.slot))
const sourcePane = tierPaneOf(otherPane.s)
const targetPane = tierPaneOf(focusedPane.s)
/** A point inside the pane that is not the drag source: that is what a drop hits. */
const dropX = (targetPane === null ? { left: 0, width: 0 } : targetPane.rect).left
  + (targetPane === null ? { left: 0, width: 0 } : targetPane.rect).width / 2
const chrome = queryIn(sourcePane, '.dsh-split-chrome')
dispatchTo(chrome, domEvent('pointerdown', { button: 0, pointerId: 3, clientX: 10, clientY: 10 }))
dispatchWindow('pointermove', domEvent('pointermove', { pointerId: 3, clientX: 12, clientY: 11 }))
check('a move under the drag threshold starts nothing',
  hasClassOf(sourcePane, 'is-dragging') === false && hasClassOf(targetPane, 'is-drop-target') === false,
  classesOf(sourcePane))
transcript.slot = 0
const orderBefore = listOf(painting.face.hooks.split.getSnapshot().root).map((pane) => pane.s).join(',')
dispatchWindow('pointermove', domEvent('pointermove', { pointerId: 3, clientX: dropX, clientY: 20 }))
check('the dragged pane is painted as the source',
  hasClassOf(sourcePane, 'is-dragging'), classesOf(sourcePane))
check('the pane under the pointer is painted as the drop target',
  hasClassOf(targetPane, 'is-drop-target'), classesOf(targetPane))
check('the drag hover re-renders no transcript', transcript.slot === 0, String(transcript.slot))
check('no swap happens before the release',
  listOf(painting.face.hooks.split.getSnapshot().root).map((pane) => pane.s).join(',') === orderBefore,
  listOf(painting.face.hooks.split.getSnapshot().root).map((pane) => pane.s).join(','))
dispatchWindow('pointerup', domEvent('pointerup', { pointerId: 3, clientX: dropX, clientY: 20 }))
check('the release swaps the two panes',
  listOf(painting.face.hooks.split.getSnapshot().root).map((pane) => pane.s).join(',') !== orderBefore,
  listOf(painting.face.hooks.split.getSnapshot().root).map((pane) => pane.s).join(','))
check('the drop highlight is gone after the swap',
  tierPanes().length === 2
  && tierPanes().every((pane) => !pane.classList.contains('is-drop-target')
    && !pane.classList.contains('is-dragging')),
  tierPanes().map((pane) => pane.className).join(' | '))
painting.tree.unmount()

console.log('\nstateful tier: the listener and observer ledger')
const ledgerRun = tierMount()
const observersBefore = resizeObservers.length
tierStageAll()
check('the measure effect holds one resize listener while open',
  liveWindowListeners('resize') === resizeIdle + 1, String(liveWindowListeners('resize')))
const ledgerChrome = queryIn(tierPaneOf('s2'), '.dsh-split-chrome')
dispatchTo(ledgerChrome, domEvent('pointerdown', { button: 0, pointerId: 5, clientX: 20, clientY: 20 }))
check('a pane drag registers its three window listeners',
  liveWindowListeners('pointermove') === 1 && liveWindowListeners('pointerup') === 1
  && liveWindowListeners('pointercancel') === 1,
  ['pointermove', 'pointerup', 'pointercancel'].map((type) => type + ':' + liveWindowListeners(type)).join(' '))
dispatchWindow('pointercancel', domEvent('pointercancel', { pointerId: 5, clientX: 20, clientY: 20 }))
check('the release removes them again',
  liveWindowListeners('pointermove') === 0 && liveWindowListeners('pointerup') === 0
  && liveWindowListeners('pointercancel') === 0,
  ['pointermove', 'pointerup', 'pointercancel'].map((type) => type + ':' + liveWindowListeners(type)).join(' '))
dispatchTo(ledgerChrome, domEvent('pointerdown', { button: 0, pointerId: 6, clientX: 20, clientY: 20 }))
check('a drag in flight holds them', liveWindowListeners('pointerup') === 1,
  String(liveWindowListeners('pointerup')))
ledgerRun.tree.unmount()
check('unmounting mid-drag releases the drag listeners',
  liveWindowListeners('pointermove') === 0 && liveWindowListeners('pointerup') === 0
  && liveWindowListeners('pointercancel') === 0,
  ['pointermove', 'pointerup', 'pointercancel'].map((type) => type + ':' + liveWindowListeners(type)).join(' '))
check('every window listener that was added was removed',
  unbalancedWindowTypes().length === 0, unbalancedWindowTypes().join(','))
check('every observer of this run was disconnected',
  resizeObservers.slice(observersBefore).every((observer) => observer.disconnected)
  && liveResizeObservers().length === 0,
  String(liveResizeObservers().length) + ' live')

console.log('\nstateful tier: the divider drag')
const divider = tierMount()
tierStageAll()
const handle = queryIn(tierRoot(), '.dsh-split-handle')
check('the split renders one divider handle',
  handle !== null && handle.getAttribute('role') === 'separator',
  handle === null ? 'no handle' : String(handle.getAttribute('role')))
const dividerBox = handle === null ? null : handle.parentElement
const cells = dividerBox === null ? [] : dividerBox.children
if (dividerBox !== null) dividerBox.rect = { left: 0, top: 0, width: 800, height: 600 }
if (handle !== null) handle.rect = { left: 396, top: 0, width: 8, height: 600 }
const ratioNow = () => divider.face.hooks.split.getSnapshot().root.r
check('the divider starts at the stored share, shown by both cells',
  ratioNow() === 0.5 && cells.length === 3
  && flexOf(cells, 0) === '0.5 1 0%' && flexOf(cells, 2) === '0.5 1 0%',
  String(ratioNow()) + ' ' + flexOf(cells, 0) + ' / ' + flexOf(cells, 2))
dispatchTo(handle, domEvent('pointerdown', { button: 0, pointerId: 9, clientX: 400, clientY: 300 }))
check('the press paints the handle and captures the pointer',
  hasClassOf(handle, 'is-dragging') && captureOf(handle, 9), classesOf(handle))
dispatchTo(handle, domEvent('pointermove', { pointerId: 9, clientX: 598, clientY: 300 }))
check('the drag previews the share on the two cells',
  flexOf(cells, 0) === '0.75 1 0%' && flexOf(cells, 2) === '0.25 1 0%',
  flexOf(cells, 0) + ' / ' + flexOf(cells, 2))
check('the preview publishes no ratio', ratioNow() === 0.5, String(ratioNow()))
dispatchTo(handle, domEvent('pointermove', { pointerId: 9, clientX: 1400, clientY: 300 }))
check('a drag past the end of the track previews the clamp bound, not the pointer',
  flexOf(cells, 0) === '0.88 1 0%' && flexOf(cells, 2) === String(1 - 0.88) + ' 1 0%',
  flexOf(cells, 0) + ' / ' + flexOf(cells, 2))
dispatchTo(handle, domEvent('pointerup', { pointerId: 8, clientX: 1400, clientY: 300 }))
check('a release from another pointer commits nothing',
  ratioNow() === 0.5 && hasClassOf(handle, 'is-dragging'),
  String(ratioNow()) + ' ' + classesOf(handle))
dispatchTo(handle, domEvent('pointerup', { pointerId: 9, clientX: 1400, clientY: 300 }))
check('the release commits a clamped share', Math.abs(ratioNow() - 0.88) < 1e-9, String(ratioNow()))
check('the committed share is what the cells render',
  flexOf(cells, 0) === '0.88 1 0%' && flexOf(cells, 2) === String(1 - ratioNow()) + ' 1 0%',
  flexOf(cells, 0) + ' / ' + flexOf(cells, 2))
check('the handle leaves its drag state and the capture',
  hasClassOf(handle, 'is-dragging') === false && captureOf(handle, 9) === false,
  classesOf(handle))
dispatchTo(handle, domEvent('dblclick', {}))
check('a double click returns the divider to the middle',
  Math.abs(ratioNow() - 0.5) < 1e-9, String(ratioNow()))
const ratioBeforeRightClick = ratioNow()
dispatchTo(handle, domEvent('pointerdown', { button: 2, pointerId: 10, clientX: 400, clientY: 300 }))
dispatchTo(handle, domEvent('pointerup', { pointerId: 10, clientX: 598, clientY: 300 }))
check('a non-primary press never arms a drag',
  ratioNow() === ratioBeforeRightClick && hasClassOf(handle, 'is-dragging') === false,
  String(ratioNow()) + ' ' + classesOf(handle))
divider.tree.unmount()

const midDrag = tierMount()
tierStageAll()
const midHandle = queryIn(tierRoot(), '.dsh-split-handle')
if (midHandle !== null) {
  midHandle.parentElement.rect = { left: 0, top: 0, width: 800, height: 600 }
  midHandle.rect = { left: 396, top: 0, width: 8, height: 600 }
}
const midRatio = () => midDrag.face.hooks.split.getSnapshot().root.r
dispatchTo(midHandle, domEvent('pointerdown', { button: 0, pointerId: 11, clientX: 400, clientY: 300 }))
dispatchTo(midHandle, domEvent('pointermove', { pointerId: 11, clientX: 598, clientY: 300 }))
check('the divider is mid-drag with a preview showing',
  hasClassOf(midHandle, 'is-dragging') && midRatio() === 0.5,
  classesOf(midHandle))
midDrag.tree.unmount()
check('unmounting mid-drag commits nothing and releases the capture',
  midRatio() === 0.5 && captureOf(midHandle, 11) === false, String(midRatio()))

const cancelled = tierMount()
tierStageAll()
const cancelHandle = queryIn(tierRoot(), '.dsh-split-handle')
if (cancelHandle !== null) {
  cancelHandle.parentElement.rect = { left: 0, top: 0, width: 800, height: 600 }
  cancelHandle.rect = { left: 396, top: 0, width: 8, height: 600 }
}
const cancelRatio = () => cancelled.face.hooks.split.getSnapshot().root.r
dispatchTo(cancelHandle, domEvent('pointerdown', { button: 0, pointerId: 12, clientX: 400, clientY: 300 }))
dispatchTo(cancelHandle, domEvent('pointermove', { pointerId: 12, clientX: 598, clientY: 300 }))
dispatchTo(cancelHandle, domEvent('pointercancel', { pointerId: 12, clientX: 598, clientY: 300 }))
check('a cancelled drag keeps the share it was showing, once',
  Math.abs(cancelRatio() - 0.75) < 1e-9 && captureOf(cancelHandle, 12) === false,
  String(cancelRatio()))
cancelled.tree.unmount()

console.log('\nstateful tier: the picker fills an empty pane')
const picking = tierMount({ own: true, ids: ['s1', 's2'] })
tierStageAll()
const pickingSnapshot = picking.face.hooks.split.getSnapshot()
const emptyPane = listOf(pickingSnapshot.root).find((pane) => pane.s === null)
check('the split is focused after the menu action',
  pickingSnapshot.focus !== null,
  emptyPane === undefined ? 'no empty pane' : String(pickingSnapshot.focus))
const pickerRows = descendantsIn(tierRoot(), '.dsh-split-row')
check('no pane asks the user to choose after a split',
  pickerRows.length === 0,
  pickerRows.map((row) => textOf(row)).join(' | '))
const rowOfS3 = pickerRows.length === 0 ? null : pickerRows[0]
transcript.slot = 0
dispatchTo(rowOfS3, domEvent('click', {}))
check('both panes host their conversation',
  tierPaneOf('s2') !== null
  && hostsConversation('s1') && hostsConversation('s2'),
  tierPanes().map((pane) => pane.getAttribute('data-split-session')).join(','))
check('the picker is gone once the pane is bound',
  queryIn(tierRoot(), '.dsh-split-picker') === null)
check('a split mounts a body per pane',
  hostsConversation('s1') && hostsConversation('s2'), String(transcript.slot))
picking.tree.unmount()

console.log('\nstateful tier: the file-drop fence and its notice')
const fencing = tierMount()
tierStageAll()
const fenceNode = tierRoot()
const overEvent = domEvent('dragover', { dataTransfer: { types: ['Files'], dropEffect: 'copy' } })
dispatchTo(fenceNode, overEvent)
check('a file dragged over the split is refused at the root',
  overEvent.defaultPrevented === true && overEvent.stopped === true
  && overEvent.dataTransfer.dropEffect === 'none',
  String(overEvent.dataTransfer.dropEffect))
transcript.slot = 0
const dropEvent = domEvent('drop', { dataTransfer: { types: ['Files'], dropEffect: 'none' } })
dispatchTo(fenceNode, dropEvent)
check('a file drop is stopped and explained',
  dropEvent.defaultPrevented === true && dropEvent.stopped === true
  && queryIn(fenceNode, '.dsh-split-notice') !== null,
  String(textOf(queryIn(fenceNode, '.dsh-split-notice'))))
check('showing the notice re-renders no transcript', transcript.slot === 0, String(transcript.slot))
const leaveEvent = domEvent('dragleave', { dataTransfer: { types: ['Files'] } })
dispatchTo(fenceNode, leaveEvent)
check('a leave is fenced but not cancelled',
  leaveEvent.defaultPrevented === false && leaveEvent.stopped === true,
  String(leaveEvent.defaultPrevented) + '/' + String(leaveEvent.stopped))
const textEvent = domEvent('drop', { dataTransfer: { types: ['text/plain'] } })
dispatchTo(fenceNode, textEvent)
check('a drop that carries no file passes through',
  textEvent.defaultPrevented === false && textEvent.stopped === false,
  String(textEvent.defaultPrevented) + '/' + String(textEvent.stopped))
flushTimersOf(4000)
check('the explanation clears itself after its timeout',
  queryIn(tierRoot(), '.dsh-split-notice') === null)
fencing.tree.unmount()

console.log('\nstateful tier: closing the view tears the rendered overlay down')
const closing = tierMount()
tierStageAll()
check('an open split covers the centre column with all three markers',
  domCenter.hasAttribute('data-dsh-covered') && domCenter.hasAttribute('inert')
  && domCenter.getAttribute('aria-hidden') === 'true',
  JSON.stringify([...domCenter.attributes]))
check('the rendered overlay holds both conversations',
  tierTranscripts().length === 2, String(tierTranscripts().length))
closing.context.pressFixed('KeyS')
flushFrames()
check('closing removes the rendered panes and leaves the fading shell',
  tierTranscripts().length === 0 && tierRoot() !== null
  && tierRoot().hasAttribute('data-split-closing'),
  tierRoot() === null ? 'no root' : String(tierTranscripts().length) + ' bodies')
check('and uncovers the column again',
  domCenter.hasAttribute('data-dsh-covered') === false && domCenter.hasAttribute('inert') === false
  && domCenter.hasAttribute('aria-hidden') === false,
  JSON.stringify([...domCenter.attributes]))
check('and releases the measure listener',
  liveWindowListeners('resize') === resizeIdle, String(liveWindowListeners('resize')))
flushTimers()
check('the closing shell fades out and unmounts', tierRoot() === null)
closing.tree.unmount()

console.log('\nstateful tier: nothing is left behind')
flushFrames()
flushTimers()
check('no window listener is left unbalanced',
  unbalancedWindowTypes().length === 0, unbalancedWindowTypes().join(','))
check('no ResizeObserver is left watching anything',
  liveResizeObservers().length === 0, String(liveResizeObservers().length))
check('no MutationObserver is left watching anything',
  mutationObservers.every((observer) => observer.disconnected || observer.targets.length === 0),
  String(mutationObservers.filter((observer) => !observer.disconnected && observer.targets.length > 0).length))
check('the frame carries no covered marker',
  domCenter.hasAttribute('data-dsh-covered') === false, JSON.stringify([...domCenter.attributes]))

console.log('\nthe right column follows the focused pane')

// A is open, B is closed: focusing B navigates once and re-opens B's column (its start page),
// while A's open state is left alone. The fake models the real service: the column draws the
// current Session, and its open state is stored per Session.
storage.clear()
const rbA = createFakeContext()
exportsObject.apply(rbA.ctx)
const rbAFace = rbA.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const rbAMenu = rbA.slots.find((entry) => entry.options.id === 'dsh-split.right').options.inject()
rbA.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
rbA.setCurrent('s1')
rbA.rightbar.set('s1', true)
rbA.rightbar.set('s2', false)
rbAMenu.run('s2')
flushTimers()
flushFrames()
flushFrames()
const rbASnapshot = rbAFace.hooks.split.getSnapshot()
const rbATargetPane = listOf(rbASnapshot.root).find((pane) => pane.s === 's2')
check('a follow navigation re-takes the shared editor after the covered mount',
  rbATargetPane !== undefined && (rbASnapshot.gens.get(rbATargetPane.id) ?? 0) === 2,
  'gens=' + (rbATargetPane === undefined ? '?' : rbASnapshot.gens.get(rbATargetPane.id)))
check('focusing another pane makes its Session current once',
  rbA.events.filter((event) => event === 'open:s2').length === 1, rbA.events.join(','))
check('and re-opens the column that would have collapsed',
  rbA.toggles.length === 1 && rbA.rightbar.get('s2') === true,
  'toggles=' + rbA.toggles.length + ' s2=' + rbA.rightbar.get('s2'))
check('the Session that was open stays open', rbA.rightbar.get('s1') === true)

// A is collapsed, B is open: focusing B must NOT pop anything open (the 没有->有 scenario), and
// the follow is remembered until the user opens the column.
storage.clear()
const rbB = createFakeContext()
exportsObject.apply(rbB.ctx)
const rbBFace = rbB.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const rbBMenu = rbB.slots.find((entry) => entry.options.id === 'dsh-split.right').options.inject()
rbB.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
rbB.setCurrent('s1')
rbB.rightbar.set('s1', false)
rbB.rightbar.set('s2', true)
rbBMenu.run('s2')
flushTimers()
check('a collapsed column defers the follow instead of navigating',
  !rbB.events.includes('open:s2') && rbB.rightbar.get('s2') === true, rbB.events.join(','))
rbBFace.toggleRightbar()
flushTimers()
check('opening the column applies the deferred follow and keeps it open',
  rbB.events.filter((event) => event === 'open:s2').length === 1
  && rbB.rightbar.get('s2') === true,
  rbB.events.join(',') + ' toggles=' + rbB.toggles.length)

// An outside navigation onto a Session a pane shows must focus that pane without navigating
// again: the follow gate sees the Session is already current and does nothing.
storage.clear()
const rbC = createFakeContext()
exportsObject.apply(rbC.ctx)
const rbCFace = rbC.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const rbCMenu = rbC.slots.find((entry) => entry.options.id === 'dsh-split.right').options.inject()
rbC.setList({ phase: 'ready', ids: ['s1', 's2'], byId: { s1: {}, s2: {} } })
rbC.setCurrent('s1')
rbC.rightbar.set('s1', true)
rbC.rightbar.set('s2', true)
rbCMenu.run('s2')
flushTimers()
const rbCBefore = rbC.events.length
rbC.setCurrent('s1')
flushTimers()
const rbCFocused = listOf(rbCFace.hooks.split.getSnapshot().root)
  .find((pane) => pane.id === rbCFace.hooks.split.getSnapshot().focus)
check('an outside navigation focuses the pane without navigating again',
  rbCFocused !== undefined && rbCFocused.s === 's1' && rbC.events.length === rbCBefore,
  rbC.events.join(','))

// Closing the focused pane hands the column to the pane the focus moved to.
storage.clear()
const rbD = createFakeContext()
exportsObject.apply(rbD.ctx)
const rbDFace = rbD.slots.find((entry) => entry.options.name === 'shell.overlay').options.inject()
const rbDMenu = rbD.slots.find((entry) => entry.options.id === 'dsh-split.right').options.inject()
rbD.setList({ phase: 'ready', ids: ['s1', 's2', 's3'], byId: { s1: {}, s2: {}, s3: {} } })
rbD.setCurrent('s1')
rbD.rightbar.set('s1', true)
rbD.rightbar.set('s2', true)
rbD.rightbar.set('s3', true)
rbDMenu.run('s2')
flushTimers()
rbDMenu.run('s3')
flushTimers()
const rbDClosed = listOf(rbDFace.hooks.split.getSnapshot().root)
  .find((pane) => pane.id === rbDFace.hooks.split.getSnapshot().focus)
check('the focused pane shows s3 before closing', rbDClosed !== undefined && rbDClosed.s === 's3',
  listOf(rbDFace.hooks.split.getSnapshot().root).map((pane) => pane.s).join(','))
rbDFace.closePane(rbDClosed.id)
flushTimers()
const rbDAfter = rbDFace.hooks.split.getSnapshot()
const rbDSurvivor = listOf(rbDAfter.root).find((pane) => pane.id === rbDAfter.focus)
check('closing the focused pane hands the column to the survivor',
  rbDSurvivor !== undefined && rbD.events[rbD.events.length - 1] === 'open:' + String(rbDSurvivor.s),
  rbD.events.join(','))
console.log('')
if (failures > 0) {
  console.log(failures + ' check(s) failed')
  process.exitCode = 1
} else {
  console.log('all checks passed')
}

/** Every pane in a tree, in order. */
function listOf(node) {
  if (node === null) return []
  if (node.t === 'p') return [node]
  return listOf(node.a).concat(listOf(node.b))
}

/** True when any split in the tree kept a closed child (a pane's own `s: null` is fine). */
function hasDeadChild(node) {
  if (node === null || node.t === 'p') return false
  return node.a === null || node.b === null || hasDeadChild(node.a) || hasDeadChild(node.b)
}

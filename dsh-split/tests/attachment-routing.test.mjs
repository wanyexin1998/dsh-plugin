#!/usr/bin/env node
/**
 * Offline integration: load the actual generated attachment module, register its
 * real ComposerAttachments, mount it with React, dispatch DOM drag events, and
 * observe the native onAddFiles/droppedDirectories callback boundary. No uploads.
 * Run: node tests/attachment-routing.test.mjs --patch-root dist/host-patches-fix
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const option = process.argv.indexOf('--patch-root')
const patchRoot = resolve(repo, option < 0 ? 'patches/patched' : process.argv[option + 1])
const artifact = resolve(patchRoot, 'dsh-client-ui-attachment/lib/client.js')
const source = readFileSync(artifact, 'utf8')
console.log('attachment artifact:', artifact)
console.log('sha256:', createHash('sha256').update(source).digest('hex'))

async function fixture(t, { order = ['A', 'B'], split = true, disabled = [], nested = false, noConversationMarker = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="outside">Outside</div></body></html>', {
    url: 'https://dsh-attachment-test.invalid/', pretendToBeVisual: true,
  })
  for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'CustomEvent']) {
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true })
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const React = require('react')
  const ReactDOM = require('react-dom')
  const { createRoot } = require('react-dom/client')
  const act = React.act ?? require('react-dom/test-utils').act
  const create = React.createElement
  const registered = new Map()
  const counters = new Map()
  const watched = new Set(['dragenter', 'dragover', 'dragleave', 'drop', 'dragend'])
  const undo = []
  for (const target of [document, window]) {
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target)
    target.addEventListener = (type, callback, options) => {
      if (watched.has(type) && !options) {
        const key = (target === document ? 'document:' : 'window:') + type
        if (!counters.has(key)) counters.set(key, new Set())
        counters.get(key).add(callback)
      }
      return add(type, callback, options)
    }
    target.removeEventListener = (type, callback, options) => {
      if (watched.has(type) && !options) counters.get((target === document ? 'document:' : 'window:') + type)?.delete(callback)
      return remove(type, callback, options)
    }
    undo.push(() => { target.addEventListener = add; target.removeEventListener = remove })
  }
  let api
  vm.runInNewContext(source, {
    document, window: { ...window, __ModuleLoader__: { load({ factory }) {
      api = factory(name => {
        if (name === 'react') return React
        if (name === 'react-dom') return ReactDOM
        if (name === 'react/jsx-runtime') return require(name)
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: () => () => null })
        throw new Error('Unexpected attachment dependency: ' + name)
      })
    } } }, console,
  }, { filename: artifact })
  api.apply({ slots: {
    inject(_name, setup) { setup() },
    register(options, component) { registered.set(options.name, component); return () => {} },
  } })
  const Composer = registered.get('conversation.input.attachments')
  assert.equal(typeof Composer, 'function', 'load the public plugin registration, not an extracted test replacement')
  if (split) document.documentElement.setAttribute('data-dsh-plugin-main-host', 'dsh-split')
  const records = new Map(), calls = []
  const ids = [...new Set([...order, ...(nested ? ['child'] : [])])]
  for (const id of ids) {
    const surface = document.createElement('section')
    if (split) {
      surface.setAttribute('data-dsh-split-session', id)
      surface.setAttribute('data-dsh-split-focused', id === 'A' ? 'true' : 'false')
    }
    surface.innerHTML = '<header data-dsh-split-titlebar>Title</header><div data-dsh-split-body><main><div data-target><span>Drop here</span></div><div data-mount></div></main><aside data-dsh-sidebar-host>Sidebar</aside></div>'
    const conversation = surface.querySelector('main')
    if (!noConversationMarker) conversation.setAttribute('data-conversation-session', id)
    document.body.append(surface)
    records.set(id, {
      surface, conversation, target: surface.querySelector('[data-target] span'),
      root: createRoot(surface.querySelector('[data-mount]')),
      accepting: !disabled.includes(id), mounted: false,
      onAddFiles: (files, directories) => calls.push({ id, files, directories }),
    })
  }
  if (nested) {
    const child = records.get('child')
    child.surface.removeAttribute('data-dsh-split-session')
    records.get('A').surface.querySelector('[data-dsh-sidebar-host]').append(child.surface)
  }
  const render = async (id, accepting = records.get(id).accepting) => {
    const record = records.get(id)
    record.accepting = accepting
    await act(async () => {
      record.root.render(create(Composer, {
        attachments: [], canAcceptDrop: accepting, onAddFiles: record.onAddFiles,
        onRemoveAttachment() {}, uploads: {}, onRetryFile() {}, t: key => key,
      }))
    })
    record.mounted = true
  }
  for (const id of [...order, ...(nested ? ['child'] : [])]) await render(id)
  const overlays = () => [...document.querySelectorAll('[role="status"]')]
  const file = (name, text = '') => new dom.window.File([text], name, { type: 'text/plain' })
  const transfer = (files = [file('synthetic.txt', 'safe test data')], directories = new Set(), types = ['Files']) => ({
    files, types, dropEffect: 'uninitialized',
    items: files.map(value => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: directories.has(value) }) })),
  })
  const dispatch = async (type, target = document.body, dataTransfer = transfer(), extra = {}) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
    for (const [key, value] of Object.entries({ dataTransfer, clientX: 40, clientY: 40, ...extra })) {
      Object.defineProperty(event, key, { value })
    }
    await act(async () => { target.dispatchEvent(event) })
    return event
  }
  const unmount = async id => {
    const record = records.get(id)
    if (record.mounted) await act(async () => { record.root.unmount() })
    record.mounted = false
  }
  t.after(async () => {
    for (const id of records.keys()) await unmount(id)
    for (const callbacks of counters.values()) assert.equal(callbacks.size, 0, 'all attachment listeners must be removed')
    for (const restore of undo.reverse()) restore()
    dom.window.close()
  })
  return { records, calls, render, overlays, file, transfer, dispatch, unmount, counters, document, window }
}

for (const order of [['A', 'B'], ['B', 'A']]) {
  test(`actual Composer routes A/B by DOM target with listener order ${order.join(' -> ')}`, async t => {
    const h = await fixture(t, { order })
    const a = h.records.get('A'), b = h.records.get('B')
    await h.dispatch('dragenter', a.target)
    assert.equal(h.overlays().length, 1)
    assert.equal(window.getComputedStyle(h.overlays()[0]).pointerEvents, 'none', 'native body-portal overlay must not steal later drag targets')
    await h.dispatch('dragenter', b.target)
    await h.dispatch('dragleave', a.target, h.transfer(), { relatedTarget: b.target })
    assert.equal(h.overlays().length, 1, 'late A dragleave must not erase B invitation')
    const data = h.transfer()
    await h.dispatch('dragover', b.target, data)
    assert.equal(data.dropEffect, 'copy')
    await h.dispatch('drop', b.target, data)
    assert.deepEqual(h.calls.map(call => call.id), ['B'], 'non-focused B is the actual receiver')
    assert.equal(a.surface.getAttribute('data-dsh-split-focused'), 'true', 'routing must not require a focus change')
    assert.equal(h.overlays().length, 0)
    await h.dispatch('drop', a.target)
    assert.deepEqual(h.calls.map(call => call.id), ['B', 'A'])
  })
}

test('a disabled target rejects files instead of falling through to the enabled foreground', async t => {
  const h = await fixture(t, { disabled: ['B'] })
  const target = h.records.get('B').target, data = h.transfer()
  await h.dispatch('dragenter', target, data)
  assert.equal(h.overlays().length, 1)
  assert.match(h.overlays()[0].textContent, /attachment.dropBlocked/)
  await h.dispatch('dragover', target, data)
  assert.equal(data.dropEffect, 'none')
  assert.equal((await h.dispatch('drop', target, data)).defaultPrevented, true)
  assert.equal(h.calls.length, 0)
  assert.equal(h.overlays().length, 0)
})

test('split titlebar, Sidebar blank, body gutter and external targets reject rather than misroute', async t => {
  const h = await fixture(t)
  const a = h.records.get('A')
  const targets = [a.surface.querySelector('header'), a.surface.querySelector('aside'), a.surface.querySelector('[data-dsh-split-body]'), document.querySelector('#outside')]
  for (const target of targets) {
    await h.dispatch('dragenter', a.target)
    const data = h.transfer()
    await h.dispatch('dragover', target, data)
    assert.equal(data.dropEffect, 'none')
    assert.equal(h.overlays().length, 0)
    assert.equal((await h.dispatch('drop', target, data)).defaultPrevented, true)
  }
  assert.equal(h.calls.length, 0)
  const textDrop = await h.dispatch('drop', a.target, h.transfer([], new Set(), ['text/plain']))
  assert.equal(textDrop.defaultPrevented, false, 'ordinary text/HTML drops remain native')
})

test('capture-phase veto clears every overlay without intake; viewport leave and dragend clean up', async t => {
  const h = await fixture(t)
  const a = h.records.get('A').target
  await h.dispatch('dragenter', a)
  const veto = event => event.preventDefault()
  document.addEventListener('drop', veto, true)
  await h.dispatch('drop', a)
  document.removeEventListener('drop', veto, true)
  assert.equal(h.calls.length, 0)
  assert.equal(h.overlays().length, 0)
  await h.dispatch('dragenter', a)
  document.addEventListener('dragover', veto, true)
  await h.dispatch('dragover', a)
  document.removeEventListener('dragover', veto, true)
  assert.equal(h.overlays().length, 0)
  document.addEventListener('dragenter', veto, true)
  await h.dispatch('dragenter', a)
  document.removeEventListener('dragenter', veto, true)
  assert.equal(h.overlays().length, 0)
  await h.dispatch('dragenter', a)
  await h.dispatch('dragleave', document.documentElement, h.transfer(), { clientX: 0, clientY: 0 })
  assert.equal(h.overlays().length, 0)
  await h.dispatch('dragenter', a)
  await h.dispatch('dragend', window)
  assert.equal(h.overlays().length, 0)
})

test('Sidebar subagent conversations receive their own files, never their containing pane', async t => {
  const h = await fixture(t, { nested: true })
  await h.dispatch('drop', h.records.get('child').target)
  await h.dispatch('drop', h.records.get('A').target)
  assert.deepEqual(h.calls.map(call => call.id), ['child', 'A'])
  await h.dispatch('drop', h.records.get('A').surface.querySelector('aside'))
  assert.equal(h.calls.length, 2, 'Sidebar blank space is not a parent or subagent composer')
})

test('native single-view document drop stays available; multiple native views require a concrete target', async t => {
  const h = await fixture(t, { order: ['A'], split: false })
  await h.dispatch('drop', document.querySelector('#outside'))
  assert.deepEqual(h.calls.map(call => call.id), ['A'])
})

test('multiple native composers do not arbitrate an external target by listener order', async t => {
  const h = await fixture(t, { split: false, order: ['B', 'A'] })
  await h.dispatch('drop', document.querySelector('#outside'))
  assert.equal(h.calls.length, 0)
  await h.dispatch('drop', h.records.get('A').target)
  assert.deepEqual(h.calls.map(call => call.id), ['A'])
})

test('native directory detection preserves original File objects, order and entry-API fallback', async t => {
  const h = await fixture(t)
  const empty = h.file('empty.txt'), folder = h.file('directory'), full = h.file('file.txt', 'synthetic')
  const files = [empty, folder, full], data = h.transfer(files, new Set([folder]))
  data.items.splice(1, 0, { kind: 'string' })
  await h.dispatch('drop', h.records.get('B').target, data)
  const call = h.calls[0]
  assert.equal(call.id, 'B')
  assert.deepEqual([...call.files], files)
  assert.equal(call.files[1], folder)
  assert.equal(call.directories.size, 1)
  assert.equal(call.directories.has(folder), true)
  assert.equal(call.directories.has(empty), false, 'an ordinary empty file is not a directory')
  const fallback = h.transfer(files)
  fallback.items = files.map(() => ({ kind: 'file' }))
  await h.dispatch('drop', h.records.get('A').target, fallback)
  assert.equal(h.calls[1].directories.size, 0)
})

test('effect rebind and unmount remove old listeners and invitations, without duplicate intake', async t => {
  const h = await fixture(t, { order: ['A'] })
  const a = h.records.get('A')
  await h.dispatch('dragenter', a.target)
  await h.render('A', false)
  assert.equal(h.overlays().length, 0, 'replacing listeners clears the old invitation')
  for (const callbacks of h.counters.values()) assert.equal(callbacks.size, 1)
  await h.dispatch('drop', a.target)
  assert.equal(h.calls.length, 0)
  await h.render('A', true)
  await h.dispatch('drop', a.target)
  assert.equal(h.calls.length, 1)
  await h.dispatch('dragenter', a.target)
  await h.unmount('A')
  assert.equal(h.overlays().length, 0)
  for (const callbacks of h.counters.values()) assert.equal(callbacks.size, 0)
  assert.equal((await h.dispatch('drop', a.target)).defaultPrevented, false)
  assert.equal(h.calls.length, 1)
})

test('a host without conversation markers falls back only to the split body content', async t => {
  const h = await fixture(t, { noConversationMarker: true })
  await h.dispatch('drop', h.records.get('B').target)
  await h.dispatch('drop', h.records.get('A').surface.querySelector('header'))
  await h.dispatch('drop', h.records.get('A').surface.querySelector('aside'))
  assert.deepEqual(h.calls.map(call => call.id), ['B'])
})

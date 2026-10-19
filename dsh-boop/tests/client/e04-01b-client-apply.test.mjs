#!/usr/bin/env node
/**
 * E04-01 batch 2 · real client-bundle activation (registration + style cleanup).
 *
 * Loads the GENERATED `lib/client.js` in jsdom exactly as the module loader does
 * (`window.__ModuleLoader__.load({ id, factory })`), then runs the plugin body
 * against a recording client context. This proves the integration facts that
 * component tests cannot:
 *  - the module id is the package name `dsh-boop` and React comes from the
 *    platform module table (`require('react')`), never a second copy;
 *  - only additive seats are registered: root `main` key `boop.tasks`, the
 *    fixed `sidebar.footer.action` entry, the `sidebar.panellist` icon,
 *    `conversation.input.dock` and `conversation.session.header.actions`; the
 *    reserved `conversation` main key is never touched;
 *  - activation resolves the main-Session identity but never navigates or
 *    creates a Session by itself;
 *  - clicking the registered fixed entry creates the named Session once through
 *    the native service, opens it via native navigation and repeats idempotently;
 *  - scoped styles carry BOOP-only selectors, honour the app's theme signal and
 *    reduced motion, and are removed when the plugin's effects dispose (FE-12);
 *  - a throwing context never blocks boot.
 *
 * Run: node --test --test-force-exit tests/client/e04-01b-client-apply.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { test, before, after } from 'node:test'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'

const require = createRequire(import.meta.url)
void require
const BUNDLE = path.resolve(import.meta.dirname, '../../lib/client.js')
let dom
let dir
let revision = 0

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-e04-01b-bundle-'))
  const { JSDOM } = await import('jsdom')
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
})

after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

/** Load and materialize the generated bundle the way the browser loader does. */
async function loadClientBundle() {
  let definition = null
  window.__ModuleLoader__ = {
    load(value) {
      definition = value
    },
  }
  const url = `${pathToFileURL(BUNDLE).href}?rev=${++revision}`
  await import(url)
  assert.ok(definition, 'the bundle registers one module factory')
  const exported = definition.factory((name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected platform module request: ${name}`)
  })
  return { definition, exported }
}

function makeContext({ hostFacts = null } = {}) {
  const effects = []
  const registrations = []
  const injections = []
  const rpcCalls = []
  const panels = []
  const opened = []
  const created = []
  const byId = {}
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
    },
    slots: {
      inject(key, factory) {
        const dispose = factory()
        injections.push(key)
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => undefined
      },
    },
    layout: { selectPanel: (id) => panels.push(id) },
    connection: {
      rpc: {
        call: async (channel, endpoint, payload) => {
          rpcCalls.push({ channel, endpoint, payload })
          if (endpoint === 'boop/mainSession') {
            return {
              ok: true,
              value:
                hostFacts ?? {
                  schemaVersion: 1,
                  state: 'bound',
                  mainSessionId: 'boop-main',
                  scopeId: 'boop-abc123',
                  writable: true,
                  durable: true,
                  reason: null,
                  storage: { ok: true, path: '/x/boop.sqlite', scopeId: 'boop-abc123', leaseHeld: true },
                },
            }
          }
          return { ok: false, error: { message: `unexpected endpoint ${endpoint}` } }
        },
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ byId, ids: Object.keys(byId), phase: 'ready' }) },
      refresh: async () => undefined,
      create: async (request) => {
        created.push(request)
        byId[request.sessionId] = { id: request.sessionId, blank: true }
        return request.sessionId
      },
    },
    uiWorkspace: { openSession: (id) => opened.push(id) },
  }
  return { ctx, effects, registrations, injections, rpcCalls, panels, opened, created, byId }
}

test('E04-01 the generated bundle keeps the package module id and platform React', async () => {
  const { definition } = await loadClientBundle()
  assert.equal(definition.id, 'dsh-boop', 'the module id must be the package name')
  assert.equal(typeof definition.factory, 'function')
})

test('E04-01 activation registers only additive seats and never the reserved conversation key', async () => {
  const { exported } = await loadClientBundle()
  const records = makeContext()
  exported.apply(records.ctx)
  await tick()
  assert.deepEqual(
    [...records.injections].sort(),
    [
      'conversation.input.dock',
      'conversation.session.header.actions',
      'main',
      'settings.general.item',
      'sidebar.footer.action',
      'sidebar.panellist',
    ],
    'exactly the additive seats this batch owns',
  )
  const main = records.registrations.find((entry) => entry.options.name === 'main')
  assert.equal(main.options.key, 'boop.tasks')
  assert.notEqual(main.options.key, 'conversation', 'the reserved Conversation key is never claimed')
  const dock = records.registrations.find((entry) => entry.options.name === 'conversation.input.dock')
  assert.equal(dock.options.id, 'boop-init')
  assert.ok(dock.options.order < 0, 'the initialization card sits above the shipped docks')
  const header = records.registrations.find((entry) => entry.options.name === 'conversation.session.header.actions')
  assert.equal(header.options.id, 'boop-main')
  const footer = records.registrations.find((entry) => entry.options.name === 'sidebar.footer.action')
  assert.equal(footer.options.id, 'boop-main')
  const icon = records.registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.equal(icon.options.id, 'boop.tasks', 'the icon addresses the registered main panel')
  const settings = records.registrations.find((entry) => entry.options.name === 'settings.general.item')
  assert.equal(settings.options.id, 'boop', 'one additive row in the native General section')
})

test('E04-01 activation resolves the identity but never navigates or creates a Session', async () => {
  const { exported } = await loadClientBundle()
  const records = makeContext()
  exported.apply(records.ctx)
  await tick()
  assert.deepEqual(records.rpcCalls.map((call) => call.endpoint), ['boop/mainSession'])
  assert.deepEqual(records.rpcCalls[0].payload, { args: {} }, 'the Gateway payload is one plain args field')
  assert.deepEqual(records.opened, [], 'activation never steals the current page')
  assert.deepEqual(records.created, [], 'activation never creates a Session')
  assert.deepEqual(records.panels, [], 'activation never changes the selected panel')
})

test('E04-01 the registered fixed entry creates once, opens natively, and repeats idempotently (FE-02)', async () => {
  const { exported } = await loadClientBundle()
  const records = makeContext()
  exported.apply(records.ctx)
  await tick()
  const footer = records.registrations.find((entry) => entry.options.name === 'sidebar.footer.action')
  const injected = footer.options.inject()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(React.createElement(footer.component, { wide: true, ...injected }))
  await tick()
  const button = container.querySelector('[data-boop-entry]')
  assert.ok(button, 'the entry renders in the sidebar foot')
  button.click()
  await tick()
  assert.deepEqual(records.created, [{ sessionId: 'boop-main' }], 'one native create with the durable id')
  assert.deepEqual(records.opened, ['boop-main'], 'opened by the native Conversation navigation')
  assert.deepEqual(records.panels, [], 'the reserved panel selection is not touched; openSession owns the reveal')
  button.click()
  await tick()
  assert.equal(records.created.length, 1, 'the second click must not create another main Session')
  assert.deepEqual(records.opened, ['boop-main', 'boop-main'], 'the same exact Session is re-opened')
  root.unmount()
  container.remove()
})

test('E04-01 scoped styles are BOOP-only, theme-aware, reduced-motion-aware, and disposed with the plugin (FE-09/FE-12)', async () => {
  // Earlier test activations share this jsdom document; this assertion is about
  // one activation's tags, so start from a clean head.
  for (const tag of document.head.querySelectorAll('style[data-plugin-css]')) tag.remove()
  const { exported } = await loadClientBundle()
  const records = makeContext()
  exported.apply(records.ctx)
  await tick()
  const panelStyle = document.head.querySelector('style[data-plugin-css="boop/panel"]')
  const interactionStyle = document.head.querySelector('style[data-plugin-css="boop/interaction"]')
  assert.ok(panelStyle, 'panel styles are injected under a BOOP-owned data-plugin-css tag')
  assert.ok(interactionStyle, 'interaction styles are injected under their own tag')
  const css = interactionStyle.textContent
  for (const selector of ['[data-boop-entry]', '[data-boop-header]', '[data-boop-dock]', '[data-boop-source]', '[data-boop-settings]']) {
    assert.ok(css.includes(selector), `${selector} is styled`)
  }
  assert.ok(css.includes('body[data-ds-dark-theme]'), 'dark theme follows the APP signal, not the OS media query')
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'reduced motion is honoured')
  assert.ok(css.includes('[data-boop-panel] .boop-action'), 'panel additions stay inside the BOOP panel scope')
  assert.equal(/(^|\n)\s*(html|body)\s*\{/.test(css), false, 'no bare global element rule')
  assert.equal(css.includes('.dsw-'), false, 'no host class is restyled')
  for (const effect of records.effects) {
    if (typeof effect.dispose === 'function') effect.dispose()
  }
  await tick()
  assert.equal(document.head.querySelector('style[data-plugin-css="boop/panel"]'), null, 'unload removes the panel styles')
  assert.equal(document.head.querySelector('style[data-plugin-css="boop/interaction"]'), null, 'unload removes the interaction styles')
})

test('E04-01 a throwing client context never blocks boot', async () => {
  const { exported } = await loadClientBundle()
  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    const ctx = {
      effect: () => {
        throw new Error('slots unavailable')
      },
    }
    assert.doesNotThrow(() => exported.apply(ctx), 'activation must be guarded')
    assert.ok(errors.some((line) => /activation failed|按|failed/.test(line)), 'the failure is reported, not swallowed silently')
  } finally {
    console.error = originalError
  }
})

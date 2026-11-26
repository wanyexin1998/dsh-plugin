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
 *    `sidebar.panellist` entry above the workspaces, the native right Sidebar
 *    tab, and `conversation.session.header.actions`; the reserved
 *    `conversation` main key is never touched;
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
  const tabs = []
  const tabTypes = []
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
    sidebarRight: { openTab: (kind) => tabs.push(kind) },
    sidebarRightTabs: {
      register: (definition) => {
        tabTypes.push(definition)
        return () => undefined
      },
    },
  }
  return { ctx, effects, registrations, injections, rpcCalls, panels, opened, created, byId, tabs, tabTypes }
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
      'conversation.session.header.actions',
      'main',
      'sidebar.panellist',
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab.title',
    ],
    'exactly the additive seats this batch owns',
  )
  const main = records.registrations.find((entry) => entry.options.name === 'main')
  assert.equal(main.options.key, 'boop.tasks')
  assert.notEqual(main.options.key, 'conversation', 'the reserved Conversation key is never claimed')
  const header = records.registrations.find((item) => item.options.name === 'conversation.session.header.actions')
  assert.equal(header.options.id, 'boop-main')
  const entry = records.registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.equal(entry.options.id, 'boop.tasks', 'the row above the workspaces addresses the registered main panel')
  assert.equal(entry.options.label, 'BOOP · 波波')
  const tab = records.registrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  assert.equal(tab.options.key, 'dsh-boop')
  assert.equal(records.tabTypes[0].kind, 'boop')
  assert.equal(records.registrations.some((entry) => entry.options.name === 'conversation.input.dock'), false)
  assert.equal(records.registrations.some((entry) => entry.options.name === 'shell.overlay'), false)
  assert.equal(records.registrations.some((entry) => entry.options.name === 'sidebar.footer.action'), false)
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

test('E04-01 the workspace entry opens the main Session and the native right Sidebar tab', async () => {
  const { exported } = await loadClientBundle()
  const records = makeContext()
  exported.apply(records.ctx)
  await tick()
  const panel = records.registrations.find((entry) => entry.options.name === 'main')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(React.createElement(panel.component))
  await tick()
  assert.deepEqual(records.created, [{ sessionId: 'boop-main', agentPreset: 'boop' }], 'one native create with the durable id on the BOOP preset')
  assert.deepEqual(records.opened, ['boop-main'], 'opened by the native Conversation navigation')
  assert.deepEqual(records.panels, [null], 'the selected panel returns to the Conversation')
  assert.deepEqual(records.tabs, ['boop'], 'the native right Sidebar opens the BOOP tab')
  root.unmount()
  const again = createRoot(container)
  again.render(React.createElement(panel.component))
  await tick()
  assert.equal(records.created.length, 1, 'a second open must not create another main Session')
  assert.deepEqual(records.opened, ['boop-main', 'boop-main'], 'the same exact Session is re-opened')
  again.unmount()
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
  const chatStyle = document.head.querySelector('style[data-plugin-css="boop/chat"]')
  assert.ok(panelStyle, 'panel styles are injected under a BOOP-owned data-plugin-css tag')
  assert.ok(interactionStyle, 'interaction styles are injected under their own tag')
  assert.ok(chatStyle, 'main-session chat styles are injected under their own tag')
  const css = interactionStyle.textContent
  const chatCss = chatStyle.textContent
  for (const selector of ['[data-boop-entry]', '[data-boop-header]', '[data-boop-dock]', '[data-boop-source]', '[data-boop-settings]', '[data-boop-hide-nav]', '[data-boop-session]', '[data-boop-hide-preset]']) {
    assert.ok(css.includes(selector), `${selector} is styled`)
  }
  assert.ok(chatCss.includes('[data-boop-chat]'), 'the conversation skin is scoped to the main Session mark')
  assert.ok(chatCss.includes('[data-composer-card]'), 'the native composer card is retokened, not replaced')
  assert.ok(chatCss.includes('[data-chat-flow-kind="user"]'), 'user bubbles are restyled on the native flow')
  assert.ok(chatCss.includes('[data-message-bubble]'), 'user bubbles are matched by the native data attribute')
  assert.ok(chatCss.includes('--boop-user: #d7eef6'), 'the user bubble token is the agreed BOOP fill')
  assert.ok(chatCss.includes('--dsw-alias-button-info-fill'), 'the native send button is recolored, not replaced')
  assert.ok(chatCss.includes('[data-slot="conversation.input.model"]'), 'the native model seat is hidden in the composer')
  assert.ok(chatCss.includes('[data-slot="conversation.input.permission"]'), 'the native permission seat is hidden in the composer')
  assert.match(chatCss, /\[data-composer-card\][\s\S]*?border-radius:\s*28px/, 'the composer corner is a fixed 28px')
  assert.equal(chatCss.includes('border-radius: 999px'), false, 'a tall draft does not keep stadium ends')
  assert.ok(chatCss.includes('display: grid'), 'the native editor and toolbar share one capsule row')
  assert.ok(chatCss.includes('justify-content: space-between'), 'plus stays left and send/voice stay right')
  assert.ok(chatCss.includes('[data-composer-placeholder]'), 'the placeholder clears the plus and send seats')
  assert.ok(chatCss.includes('[data-boop-multiline]'), 'a tall draft switches the capsule to a stacked card')
  assert.ok(chatCss.includes('flex-direction: column'), 'multiline keeps the toolbar under the text')
  assert.equal(chatCss.includes('[data-slot="conversation.input.activity"]'), false, 'voice input stays in the composer')
  assert.equal(chatCss.includes('flex-direction: row'), false, 'the native column card is not forced into a row')
  assert.equal(chatCss.includes('[class*="bubble"]'), false, 'hashed host bubble classes are not selected')
  assert.equal(chatCss.includes('conversation.content'), false, 'the reserved conversation factory is not claimed')
  assert.ok(css.includes('body[data-ds-dark-theme]'), 'dark theme follows the APP signal, not the OS media query')
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'reduced motion is honoured')
  assert.ok(css.includes('[data-boop-panel] .boop-action'), 'panel additions stay inside the BOOP panel scope')
  assert.equal(/(^|\n)\s*(html|body)\s*\{/.test(css), false, 'no bare global element rule')
  assert.equal(css.includes('.dsw-'), false, 'no host class is restyled')
  assert.equal(chatCss.includes('.dsw-'), false, 'the conversation skin does not restyle host classes')
  for (const effect of records.effects) {
    if (typeof effect.dispose === 'function') effect.dispose()
  }
  await tick()
  assert.equal(document.head.querySelector('style[data-plugin-css="boop/panel"]'), null, 'unload removes the panel styles')
  assert.equal(document.head.querySelector('style[data-plugin-css="boop/interaction"]'), null, 'unload removes the interaction styles')
  assert.equal(document.head.querySelector('style[data-plugin-css="boop/chat"]'), null, 'unload removes the chat styles')
})

test('E04-01 the conversation skin paints native bubbles and the composer card', async () => {
  for (const tag of document.head.querySelectorAll('style[data-plugin-css]')) tag.remove()
  const { exported } = await loadClientBundle()
  const records = makeContext()
  exported.apply(records.ctx)
  await tick()
  const surface = document.createElement('div')
  surface.setAttribute('data-boop-chat', '')
  surface.innerHTML = `
    <div data-chat-flow-kind="user"><div data-message-bubble>hello</div></div>
    <div data-chat-flow-kind="assistant-step" data-chat-group-part="response">reply</div>
    <div data-composer-card></div>
  `
  document.body.appendChild(surface)
  const view = document.defaultView
  assert.ok(view, 'jsdom exposes a window for computed style')
  const bubble = view.getComputedStyle(surface.querySelector('[data-message-bubble]'))
  const reply = view.getComputedStyle(surface.querySelector('[data-chat-group-part="response"]'))
  const card = view.getComputedStyle(surface.querySelector('[data-composer-card]'))
  assert.equal(bubble.borderRadius, '16px', 'user bubbles use the Pasta 16px corner')
  assert.equal(reply.borderRadius, '16px', 'assistant replies sit in a muted card')
  assert.equal(card.borderRadius, '28px', 'the composer corner is a fixed 28px')
  assert.equal(card.display, 'grid', 'the capsule shares one row between editor and send/voice')
  const tall = document.createElement('div')
  tall.setAttribute('data-composer-card', '')
  tall.setAttribute('data-boop-multiline', '')
  surface.appendChild(tall)
  const stacked = view.getComputedStyle(tall)
  assert.equal(stacked.borderRadius, '28px', 'a tall draft keeps the same 28px corner')
  assert.equal(stacked.flexDirection, 'column', 'multiline puts the toolbar under the text')
  const chatCss = document.head.querySelector('style[data-plugin-css="boop/chat"]').textContent
  assert.match(chatCss, /\[data-composer-card\][\s\S]*?border:\s*1px solid rgba\(11, 38, 55, 0\.12\)/, 'light theme draws a visible composer edge')
  assert.match(chatCss, /\[data-composer-card\][\s\S]*?background:\s*#ffffff/, 'the composer card stays white against the cream thread')
  surface.remove()
  for (const effect of records.effects) {
    if (typeof effect.dispose === 'function') effect.dispose()
  }
})

test('E04-01 activation stamps the native conversation by main Session id, including a blank body', async () => {
  for (const tag of document.head.querySelectorAll('style[data-plugin-css]')) tag.remove()
  const { exported } = await loadClientBundle()
  const records = makeContext()
  exported.apply(records.ctx)
  await tick(80)
  const frame = document.createElement('div')
  frame.setAttribute('data-phase', 'active')
  const content = document.createElement('div')
  content.setAttribute('data-conversation-content', '')
  content.setAttribute('data-conversation-session', 'boop-main')
  const composer = document.createElement('div')
  composer.setAttribute('data-composer-card', '')
  content.appendChild(composer)
  frame.appendChild(content)
  document.body.appendChild(frame)
  await tick(80)
  assert.equal(content.getAttribute('data-boop-chat'), '', 'the Host-bound main Session body is marked without the header chip')
  assert.equal(frame.getAttribute('data-boop-session'), '', 'the phase frame is marked so the native preset chip can be hidden')
  const ordinary = document.createElement('div')
  ordinary.setAttribute('data-conversation-content', '')
  ordinary.setAttribute('data-conversation-session', 'session-ordinary')
  document.body.appendChild(ordinary)
  await tick(80)
  assert.equal(ordinary.getAttribute('data-boop-chat'), null, 'an ordinary Session body is not marked')
  const nav = document.createElement('div')
  nav.setAttribute('data-row-key', 'session:boop-main')
  const otherNav = document.createElement('div')
  otherNav.setAttribute('data-row-key', 'session:session-ordinary')
  document.body.appendChild(nav)
  document.body.appendChild(otherNav)
  await tick(80)
  assert.equal(nav.getAttribute('data-boop-hide-nav'), '', 'the main Session row is hidden from the workspace list')
  assert.equal(otherNav.getAttribute('data-boop-hide-nav'), null, 'ordinary Session rows stay visible')
  frame.remove()
  ordinary.remove()
  nav.remove()
  otherNav.remove()
  for (const effect of records.effects) {
    if (typeof effect.dispose === 'function') effect.dispose()
  }
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

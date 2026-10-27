#!/usr/bin/env node
/**
 * E04-01 batch 2 · interaction components in jsdom.
 *
 * Proves the browser-half promises that must hold without a real browser:
 *  - the initialization card exists ONLY in the BOOP main Session and asks the
 *    read-only host endpoint for real state; it never renders an unproven
 *    success and never pretends the mode ran;
 *  - the header identity chip and the fixed entry render only BOOP surfaces;
 *  - the source card shows real coverage/emptiness/error/unavailable states and
 *    jumps by exact Session id, never by title;
 *  - ordinary Sessions produce no BOOP DOM (FE-01).
 *
 * Run: node --test --test-force-exit tests/client/e04-01b-init-source.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, before, after } from 'node:test'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BoopInitDock } from '../../lib/init.test.bundle.cjs'
import { BoopSourceCard } from '../../lib/source.test.bundle.cjs'
import { BoopEntryButton, BoopMainHeader } from '../../lib/header.test.bundle.cjs'
import { BoopSettingsRow } from '../../lib/settings.test.bundle.cjs'
import { MAIN_SESSION_ID, createMainSessionStore } from '../../lib/main-session.test.bundle.cjs'

let dir

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-e04-01b-'))
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
})

after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

async function render(Component, props) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(Component, props))
  // Effects run after paint and the settings/init rows await one host round
  // trip; give the jsdom scheduler enough time to commit the result.
  await tick(80)
  return {
    host,
    root,
    html: () => host.innerHTML,
    text: () => host.textContent ?? '',
    cleanup: () => {
      root.unmount()
      host.remove()
    },
  }
}

function makeStore(mainSessionId = MAIN_SESSION_ID) {
  return createMainSessionStore({
    mainSessionId,
    phase: 'ready',
    host: {
      schemaVersion: 1,
      state: 'bound',
      mainSessionId: MAIN_SESSION_ID,
      scopeId: 'boop-abc123',
      writable: true,
      durable: true,
      reason: null,
      storage: { ok: true, path: '/tmp/boop/boop.sqlite', scopeId: 'boop-abc123', leaseHeld: true },
    },
  })
}

const unavailableFacts = {
  schemaVersion: 1,
  mode: 'from_now',
  label: '从现在开始',
  state: 'unavailable',
  executed: false,
  reason: 'write-mode-disabled',
  copy: '写模式在 G01–G06 与 G08、G09 通过前保持关闭，初始化不会写入任何数据。',
  writeModeEnabled: false,
  gates: { G01: 'PASS', G05: 'NOT_RUN', G06: 'NOT_RUN' },
  storage: { ok: true, path: '/tmp/boop/boop.sqlite', scopeId: 'boop-abc123', writable: true },
  sources: { discovered: 3, known: 1, fresh: 1, dirty: 1, gap: 0, excluded: 1 },
  processed: 0,
  total: null,
}

test('E04-01 the initialization card is invisible in an ordinary Session (FE-01)', async () => {
  const view = await render(BoopInitDock, {
    sessionId: 'session-ordinary',
    observer: makeStore(),
    call: async () => ({ ok: true, value: unavailableFacts }),
  })
  assert.equal(view.html(), '', 'no BOOP DOM in an ordinary Session')
  view.cleanup()
})

test('E04-01 the main Session shows the same-message initialization choice, not a full-screen flow', async () => {
  const view = await render(BoopInitDock, {
    sessionId: MAIN_SESSION_ID,
    observer: makeStore(),
    call: async () => ({ ok: true, value: unavailableFacts }),
  })
  const dock = view.host.querySelector('[data-boop-dock="init"]')
  assert.ok(dock, 'the card mounts in the additive dock seat')
  assert.match(view.text(), /先选一种记忆起点/, 'the one frozen prompt line')
  const modes = [...dock.querySelectorAll('[data-boop-init-mode]')].map((button) => button.getAttribute('data-boop-init-mode'))
  assert.deepEqual(modes, ['from_now', 'learn_history', 'import_memory'], 'three choices in one card')
  assert.equal(dock.querySelector('input, textarea, [contenteditable]'), null, 'BOOP adds no second input root')
  view.cleanup()
})

test('E04-01 choosing a mode asks the read-only host endpoint and reports real unavailability', async () => {
  const calls = []
  const view = await render(BoopInitDock, {
    sessionId: MAIN_SESSION_ID,
    observer: makeStore(),
    call: async (endpoint, args) => {
      calls.push({ endpoint, args })
      return { ok: true, value: { ...unavailableFacts, mode: args.mode } }
    },
    onOpenBoard: () => undefined,
  })
  view.host.querySelector('[data-boop-init-mode="learn_history"]').click()
  await tick()
  assert.deepEqual(calls, [{ endpoint: 'boop/initApply', args: { mode: 'learn_history' } }], 'real host call with the chosen mode')
  const result = view.host.querySelector('[data-boop-init-state]')
  assert.equal(result.getAttribute('data-boop-init-state'), 'unavailable')
  assert.match(result.textContent, /写模式在 G01–G06 与 G08、G09 通过前保持关闭/)
  assert.match(result.textContent, /已执行：否（0 写入）/, 'no fake PASS')
  assert.match(result.textContent, /reason: write-mode-disabled/)
  assert.match(result.textContent, /已发现会话：3/, 'real source count is shown')
  assert.doesNotMatch(result.textContent, /已从此刻开始记录|已开始整理|已新增/, 'success copy never appears before it is true')
  assert.ok(view.host.querySelector('[role="status"]'), 'the result is announced politely')
  view.cleanup()
})

test('E04-01 the card shows a retryable error when the host call fails', async () => {
  const view = await render(BoopInitDock, {
    sessionId: MAIN_SESSION_ID,
    observer: makeStore(),
    call: async () => ({ ok: false, error: { message: 'connection refused' } }),
  })
  view.host.querySelector('[data-boop-init-mode="from_now"]').click()
  await tick()
  const alert = view.host.querySelector('[role="alert"]')
  assert.ok(alert)
  assert.match(alert.textContent, /connection refused/)
  const retry = [...view.host.querySelectorAll('button')].find((button) => button.textContent === '重试')
  assert.ok(retry, 'a failed query can be retried')
  view.cleanup()
})

test('E04-01 the main-Session header identity renders only on the exact main Session', async () => {
  const ordinary = await render(BoopMainHeader, {
    sessionId: 'session-ordinary',
    observer: makeStore(),
    onOpenBoard: () => undefined,
  })
  assert.equal(ordinary.html(), '', 'an ordinary Conversation header is untouched')
  ordinary.cleanup()

  const opened = []
  const main = await render(BoopMainHeader, {
    sessionId: MAIN_SESSION_ID,
    observer: makeStore(),
    onOpenBoard: () => opened.push('board'),
  })
  const header = main.host.querySelector('[data-boop-header]')
  assert.ok(header)
  assert.match(header.textContent, /BOOP · 波波/)
  assert.match(header.textContent, /已连接/)
  header.querySelector('.boop-header-action').click()
  assert.deepEqual(opened, ['board'])
  main.cleanup()
})

test('E04-01 a degraded identity never reads as connected in the header', async () => {
  const store = createMainSessionStore({
    mainSessionId: MAIN_SESSION_ID,
    phase: 'degraded',
    host: { state: 'unavailable', mainSessionId: MAIN_SESSION_ID, scopeId: null, writable: false, durable: false, reason: 'ledger-unavailable', storage: null },
    error: 'ledger-unavailable',
  })
  const view = await render(BoopMainHeader, { sessionId: MAIN_SESSION_ID, observer: store })
  const status = view.host.querySelector('.boop-header-status')
  assert.equal(status.getAttribute('data-tone'), 'warn')
  assert.match(status.textContent, /数据域不可用/)
  view.cleanup()
})

test('E04-01 the fixed entry activates native navigation and reports a failure instead of a fake success', async () => {
  let outcome = null
  const view = await render(BoopEntryButton, {
    wide: true,
    observer: makeStore(),
    onOpen: async () => {
      outcome = 'called'
      return { ok: false, message: '宿主会话服务不可用' }
    },
  })
  const button = view.host.querySelector('[data-boop-entry]')
  assert.ok(button.getAttribute('aria-label').includes('BOOP 主聊天'))
  button.click()
  await tick()
  assert.equal(outcome, 'called')
  assert.match(button.textContent, /打开失败/, 'the failure is visible, not swallowed')
  view.cleanup()
})

const readySources = {
  schemaVersion: 1,
  available: true,
  reason: null,
  detail: null,
  scopeId: 'boop-abc123',
  discovered: 3,
  known: 4,
  staleGenerations: 2,
  sources: [
    {
      sessionId: 'session-main-source',
      title: '分屏开发',
      sourceGeneration: 'session-main-source@4:1',
      headSeq: 41,
      throughSeq: 39,
      state: 'dirty',
      coverage: 'behind',
    },
    {
      sessionId: MAIN_SESSION_ID,
      title: 'BOOP 主聊天',
      sourceGeneration: 'boop-main@4:1',
      headSeq: 5,
      throughSeq: 5,
      state: 'fresh',
      coverage: 'full',
    },
    {
      sessionId: 'session-gap-source',
      title: null,
      sourceGeneration: 'session-gap-source@4:1',
      headSeq: 9,
      throughSeq: 4,
      state: 'gap',
      coverage: 'gap',
    },
  ],
}

test('E04-01 the source card shows real coverage states and per-Session seq', async () => {
  const view = await render(BoopSourceCard, { load: { kind: 'ready', facts: readySources }, mainSessionId: MAIN_SESSION_ID })
  assert.match(view.text(), /已发现 3/)
  assert.match(view.text(), /账本记录 4/)
  assert.match(view.text(), /过期世代 2/)
  assert.match(view.text(), /覆盖至该会话最近一轮/)
  assert.match(view.text(), /落后：还没读到最新一轮/)
  assert.match(view.text(), /存在缺口：未连续覆盖/)
  assert.match(view.text(), /覆盖：39 \/ 会话到 41/)
  assert.match(view.text(), /BOOP 主会话/, 'the main Session source is named')
  assert.match(view.text(), /旧来源世代仍在账本里/, 'stale generations are stated honestly')
  assert.match(view.text(), /未命名会话/)
  view.cleanup()
})

test('E04-01 source navigation uses the exact Session id, never a guessed title', async () => {
  const opened = []
  const view = await render(BoopSourceCard, {
    load: { kind: 'ready', facts: readySources },
    mainSessionId: MAIN_SESSION_ID,
    onOpenSession: (id) => opened.push(id),
  })
  const buttons = [...view.host.querySelectorAll('.boop-source-open')]
  assert.equal(buttons.length, 3)
  buttons[0].click()
  buttons[2].click()
  assert.deepEqual(opened, ['session-main-source', 'session-gap-source'], 'exact ids passed to native navigation')
  assert.equal(buttons[1].textContent, '打开主聊天', 'the main source offers native main-chat navigation')
  view.cleanup()
})

test('E04-01 an unverified coverage states that it was not checked against the latest round', async () => {
  const view = await render(BoopSourceCard, {
    load: {
      kind: 'ready',
      facts: {
        ...readySources,
        discovered: 1,
        known: 1,
        staleGenerations: 0,
        sources: [
          {
            sessionId: 'session-unverified',
            title: '未校验来源',
            sourceGeneration: 'session-unverified@4:1',
            headSeq: null,
            throughSeq: 7,
            state: 'processing',
            coverage: 'unverified',
          },
        ],
      },
    },
    mainSessionId: MAIN_SESSION_ID,
  })
  assert.match(view.text(), /本次未校验是否最新/)
  assert.match(view.text(), /覆盖：已读至 7/)
  assert.doesNotMatch(view.text(), /覆盖至该会话最近一轮/, 'unverified never claims full coverage')
  view.cleanup()
})

test('E04-01 the native settings row shows real facts and never fakes a toggle', async () => {
  const calls = []
  const view = await render(BoopSettingsRow, {
    observer: makeStore(),
    call: async (endpoint) => {
      calls.push(endpoint)
      return {
        ok: true,
        value: {
          scope: { dshProfileVersion: '0.2.1-rc.2', writeModeEnabled: false },
          writeMode: { blockedByGates: ['G05', 'G08', 'G09'] },
          storage: { ok: true, path: '/x/boop.sqlite', scopeId: 'boop-abc123' },
        },
      }
    },
    onOpenMain: () => undefined,
    onOpenBoard: () => undefined,
  })
  const row = view.host.querySelector('[data-boop-settings]')
  assert.ok(row, 'the additive settings row renders')
  assert.match(view.text(), /BOOP · 波波/)
  assert.match(view.text(), /写模式关闭（blockedBy: G05, G08, G09）/)
  assert.match(view.text(), /跟随宿主/)
  assert.deepEqual(calls, ['boop/bootstrap'], 'real host facts, once')
  assert.equal(row.querySelector('input, [role="switch"], select'), null, 'no fake setting control is drawn')
  view.cleanup()
})

test('E04-01 the settings row reports unavailable state instead of inventing defaults', async () => {
  const view = await render(BoopSettingsRow, {
    observer: makeStore(),
    call: async () => ({ ok: false, error: { message: 'connection refused' } }),
  })
  const alert = view.host.querySelector('[role="alert"]')
  assert.ok(alert)
  assert.match(alert.textContent, /connection refused/)
  assert.doesNotMatch(view.text(), /blockedBy|通过前/, 'no invented write-mode fact when the plane failed')
  view.cleanup()
})

test('E04-01 unavailable sources are not rendered as an empty list (FE-11)', async () => {
  const unavailable = await render(BoopSourceCard, {
    load: { kind: 'ready', facts: { ...readySources, available: false, reason: 'ledger-unavailable', sources: [], discovered: 0 } },
  })
  assert.ok(unavailable.host.querySelector('[role="alert"]'))
  assert.match(unavailable.text(), /账本不可用/)
  assert.doesNotMatch(unavailable.text(), /还没有可读取的会话来源/, 'unavailable is not emptiness')
  unavailable.cleanup()

  const error = await render(BoopSourceCard, { load: { kind: 'error', message: 'connection reset' } })
  assert.match(error.text(), /connection reset/)
  assert.doesNotMatch(error.text(), /还没有可读取的会话来源/)
  error.cleanup()

  const empty = await render(BoopSourceCard, { load: { kind: 'ready', facts: { ...readySources, sources: [], discovered: 0, known: 0, staleGenerations: 0 } } })
  assert.match(empty.text(), /还没有可读取的会话来源/, 'a real empty state is allowed when the plane is readable')
  empty.cleanup()
})

#!/usr/bin/env node
/**
 * E04-01 · 3D companion: state mapping, fallback, and lifecycle contract.
 *
 * WebGL2 cannot run in jsdom, so this suite proves the parts that must hold
 * regardless: the five-state mapping from real business facts, the still-PNG
 * fallback when the player cannot start, and that a failed start never leaves
 * an empty box or a fake animation running.
 *
 * Run: node tests/client/e04-01-companion3d.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, before, after } from 'node:test'
import React from 'react'
import { createRoot } from 'react-dom/client'

// The board module pulls the player in; jsdom has no WebGL2, which is exactly
// the fallback path we want to exercise.
const { to3DState, companionState, companionLine } = await import('../../lib/companion3d.test.bundle.cjs')

let window
let document
let dir

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-e04-01-3d-'))
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
  window = dom.window
  document = dom.window.document
  globalThis.window = window
  globalThis.document = document
})

after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const ready = {
  kind: 'ready',
  data: {
    scope: { dshProfileVersion: '0.2.1-rc.2', writeModeEnabled: false, recoveryGateArmed: true },
    capabilities: {},
    gates: { G01: 'PASS' },
    services: [],
    storage: { ok: true, path: 'x', schemaVersion: 1, lease: { held: true }, scope: { scopeId: 's' } },
  },
}

test('E04-01 five business states map onto the player\'s five clips', () => {
  assert.equal(to3DState('idle'), 'idle')
  assert.equal(to3DState('listening'), 'listen')
  assert.equal(to3DState('attention'), 'listen', 'a pending decision is not an error')
  assert.equal(to3DState('thinking'), 'think')
  assert.equal(to3DState('working'), 'think')
  assert.equal(to3DState('delivered'), 'success')
  assert.equal(to3DState('offline'), 'error')
})

test('E04-01 offline is an error state, never a cheerful idle', () => {
  const offline = companionState({ kind: 'offline' })
  assert.equal(offline, 'offline')
  assert.equal(to3DState(offline), 'error')
  assert.match(companionLine({ kind: 'offline' }), /断开|不可用|恢复/)
})

test('E04-01 a blocked gate raises attention, a healthy domain stays idle', () => {
  assert.equal(companionState(ready), 'idle')
  const blocked = {
    kind: 'ready',
    data: { ...ready.data, gates: { G01: 'PASS', G03: 'BLOCKED' } },
  }
  assert.equal(companionState(blocked), 'attention')
  assert.equal(to3DState(companionState(blocked)), 'listen')
})

test('E04-01 the loading state does not claim activity', () => {
  assert.equal(companionState({ kind: 'loading' }), 'idle')
  assert.match(companionLine({ kind: 'loading' }), /正在连接/)
})

test('E04-01 a panel with no ledger says so instead of showing a healthy idle', () => {
  const noStorage = { kind: 'ready', data: { ...ready.data, storage: null } }
  assert.match(companionLine(noStorage), /账本不可用|只读/)
})

test('E04-01 the component renders a canvas and, on WebGL failure, a still PNG', async () => {
  const { BoopCompanion3D } = await import('../../lib/companion3d.test.bundle.cjs')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const unavailable = []
  root.render(
    React.createElement(BoopCompanion3D, {
      state: 'think',
      line: '正在处理当前请求…',
      size: 120,
      onUnavailable: (reason) => unavailable.push(reason),
    }),
  )
  // jsdom has no WebGL2 and no reachable model URL; the component must settle
  // into the still-PNG fallback. Poll instead of assuming one frame is enough.
  const node = await (async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const found = host.querySelector('[data-boop-3d]')
      if (found?.querySelector('[data-boop-3d-fallback]')) return found
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return host.querySelector('[data-boop-3d]')
  })()
  assert.ok(node, 'the 3D companion mounts')
  assert.equal(node.getAttribute('data-boop-state'), 'think')
  const canvas = node.querySelector('canvas')
  assert.ok(canvas, 'a canvas exists with explicit width/height')
  assert.equal(canvas.width, 120)
  assert.equal(canvas.height, 120)
  const line = node.querySelector('[data-testid="boop-3d-line"]')
  assert.equal(line?.textContent, '正在处理当前请求…')
  // jsdom has no WebGL2 → the player must report unavailability and show a still.
  assert.ok(unavailable.length > 0, 'the failure is reported, not swallowed')
  const fallback = node.querySelector('[data-boop-3d-fallback]')
  assert.ok(fallback, 'a still PNG replaces the canvas instead of an empty box')
  assert.match(fallback.getAttribute('src'), /\/api\/boop\/state-think\.png$/)
  host.remove()
})
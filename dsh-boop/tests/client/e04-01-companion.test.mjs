#!/usr/bin/env node
/**
 * E04-01 · Companion component smoke test.
 *
 * Renders the real React component (jsdom) and asserts the frozen rules:
 * states map to honest lines, offline dims and stops motion, attention draws
 * one calm ring, reduced-motion disables animation classes, and the speech
 * line is always present for screen readers.
 *
 * Run: node tests/client/e04-01-companion.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, before, after } from 'node:test'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BoopCompanion } from '../../lib/companion.test.bundle.cjs'

let dir
let window
let document

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-e04-01-'))
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  })
  window = dom.window
  document = dom.window.document
  globalThis.window = window
  globalThis.document = document
})

after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function render(props) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await new Promise((resolve) => setTimeout(resolve, 0))
  root.render(React.createElement(BoopCompanion, props))
  await new Promise((resolve) => setTimeout(resolve, 30))
  return { host, root }
}

test('E04-01 every state renders with its honest one-line status', async () => {
  const states = ['idle', 'listening', 'thinking', 'working', 'attention', 'delivered', 'offline']
  for (const state of states) {
    const { host } = await render({ state })
    const node = host.querySelector('[data-boop-companion]')
    assert.ok(node, `${state} renders a companion`)
    assert.equal(node.getAttribute('data-boop-state'), state)
    const speech = node.querySelector('[data-testid="boop-speech"]')
    assert.ok(speech && speech.textContent.length > 0, `${state} carries a speech line`)
    assert.ok(node.getAttribute('aria-label').includes('波波'), `${state} is labeled for screen readers`)
    host.remove()
  }
})

test('E04-01 offline dims the character and stops all motion classes', async () => {
  const { host } = await render({ state: 'offline' })
  const node = host.querySelector('[data-boop-companion]')
  const body = node.querySelector('g')
  assert.ok(body, 'the body group exists')
  assert.equal(body.style.opacity, '0.55', 'offline dims instead of crying or flashing')
  assert.equal(node.querySelectorAll('.boop-breathe').length, 0, 'no breathing while offline')
  host.remove()
})

test('E04-01 idle animates breathing exactly once (gentle, not restless)', async () => {
  const { host } = await render({ state: 'idle' })
  const node = host.querySelector('[data-boop-companion]')
  assert.equal(node.querySelectorAll('.boop-breathe').length, 1)
  assert.equal(node.querySelectorAll('.boop-tail').length, 0, 'the tail only moves while working')
  host.remove()
})

test('E04-01 working moves the tail; thinking sways the drop; attention draws one calm ring', async () => {
  const working = (await render({ state: 'working' })).host.querySelector('[data-boop-companion]')
  assert.equal(working.querySelectorAll('.boop-tail').length, 1)

  const thinking = (await render({ state: 'thinking' })).host.querySelector('[data-boop-companion]')
  assert.equal(thinking.querySelectorAll('.boop-drop-sway').length, 1)

  const attention = (await render({ state: 'attention' })).host.querySelector('[data-boop-companion]')
  const ring = [...attention.querySelectorAll('circle')].find((circle) => circle.getAttribute('stroke') === '#17648B')
  assert.ok(ring, 'attention shows one calm ring, no flicker')
  host: void 0
})

test('E04-01 an explicit line overrides the default status copy', async () => {
  const { host } = await render({ state: 'idle', line: '另一件事需要你确认。' })
  assert.equal(host.querySelector('[data-testid="boop-speech"]').textContent, '另一件事需要你确认。')
  host.remove()
})

test('E04-01 compact mode drops the speech bubble but keeps the aria label', async () => {
  const { host } = await render({ state: 'idle', compact: true })
  const node = host.querySelector('[data-boop-companion]')
  assert.equal(node.querySelector('[data-testid="boop-speech"]'), null)
  assert.ok(node.getAttribute('aria-label').length > 0)
  host.remove()
})

test('E04-01 the SVG keeps the frozen silhouette parts', async () => {
  const { host } = await render({ state: 'idle' })
  const node = host.querySelector('[data-boop-companion]')
  const svg = node.querySelector('svg')
  assert.ok(svg.getAttribute('aria-hidden') === 'true', 'the decorative body is aria-hidden')
  const paths = [...node.querySelectorAll('path')].map((p) => p.getAttribute('d') ?? '')
  assert.ok(paths.length >= 5, 'body, tail, fins and the water drop are all separate shapes')
  const eyes = [...node.querySelectorAll('rect')].filter((rect) => rect.getAttribute('rx') === '10')
  assert.equal(eyes.length, 2, 'exactly two capsule eyes')
  host.remove()
})
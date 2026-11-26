import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const { apply, inject } = require('../lib/client-entry.test.cjs')
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })

function context() {
  const effects = []
  const registrations = []
  return {
    effects,
    registrations,
    effect(callback, label) { effects.push({ cleanup: callback(), label }) },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'conversation.chat.markdown.fence')
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => registrations.splice(registrations.indexOf(component), 1)
      },
    },
  }
}

test('client registers only the exact visualize fence and scoped theme', () => {
  const ctx = context()
  apply(ctx)
  assert.deepEqual(inject, ['slots'])
  assert.equal(ctx.registrations.length, 1)
  assert.equal(ctx.registrations[0].options.key, 'visualize')
  assert.equal(ctx.registrations[0].options.id, 'dsh-visualize-inline')
  assert.deepEqual(ctx.effects.map((effect) => effect.label), ['visualize-inline: theme', 'visualize-inline: markdown fence'])
  const style = dom.window.document.querySelector('style[data-plugin-css="dsh-visualize-inline"]')
  assert.ok(style.textContent.includes('.dsh-vi-chart'))
  ctx.effects[0].cleanup()
  assert.equal(dom.window.document.querySelector('style[data-plugin-css="dsh-visualize-inline"]'), null)
})

test('disabled config registers neither theme nor fence', () => {
  const ctx = context()
  apply(ctx, { enabled: false })
  assert.equal(ctx.effects.length, 0)
  assert.equal(ctx.registrations.length, 0)
})

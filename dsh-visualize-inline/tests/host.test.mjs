import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

test('host registers one namespaced system-prompt section', () => {
  let registration
  apply({ systemPrompt: { section: (options) => { registration = options } } })
  assert.equal(name, 'dsh-visualize-inline')
  assert.deepEqual(inject, ['systemPrompt'])
  assert.equal(registration.name, 'dsh-visualize-inline:output')
  assert.equal(registration.interpolate, false)
  assert.ok(registration.text.includes('visualize'))
  assert.ok(registration.retirement.includes('停用'))
})

test('V2 guidance can be withdrawn independently while V1 remains available', () => {
  let registration
  apply({ systemPrompt: { section: (options) => { registration = options } } }, { v2: false })
  assert.ok(registration.text.includes('version 固定为 1'))
  assert.equal(registration.text.includes('V2 只用于'), false)
})

test('disabled config withdraws host guidance', () => {
  let calls = 0
  apply({ systemPrompt: { section: () => { calls += 1 } } }, { enabled: false })
  assert.equal(calls, 0)
})

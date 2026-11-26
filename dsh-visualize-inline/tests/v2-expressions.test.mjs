import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateExpression, evaluateMetric, evaluateProgress, evaluateText, initialRuntimeState } from '../lib/expressions.js'

const state = initialRuntimeState({ a: { type: 'boolean', initial: true }, b: { type: 'boolean', initial: false } })

test('state initializes independently from declarations', () => {
  assert.deepEqual({ ...state }, { a: true, b: false })
  const independent = initialRuntimeState({ a: { type: 'boolean', initial: true }, b: { type: 'boolean', initial: false } })
  independent.a = false
  assert.equal(state.a, true)
})

test('ref, countTrue and concat are deterministic pure calculations', () => {
  assert.equal(evaluateExpression({ op: 'ref', key: 'a' }, state), true)
  assert.equal(evaluateExpression({ op: 'countTrue', args: [{ op: 'ref', key: 'a' }, { op: 'ref', key: 'b' }] }, state), 1)
  assert.equal(evaluateText({ op: 'concat', args: [{ op: 'countTrue', args: [{ op: 'ref', key: 'a' }] }, ' / 2'] }, state), '1 / 2')
  assert.deepEqual({ ...state }, { a: true, b: false })
})

test('invalid runtime values throw instead of returning stale values', () => {
  assert.throws(() => evaluateExpression({ op: 'ref', key: 'missing' }, state))
  assert.throws(() => evaluateText({ op: 'concat', args: ['x'.repeat(300), 'y'.repeat(300)] }, state))
  assert.throws(() => evaluateMetric({ op: 'concat', args: ['not-a-number'] }, state))
  assert.throws(() => evaluateProgress(-1, state, 3))
})

test('metric and progress accept valid derived numbers', () => {
  const count = { op: 'countTrue', args: [{ op: 'ref', key: 'a' }, { op: 'ref', key: 'b' }] }
  assert.equal(evaluateMetric(count, state), 1)
  assert.equal(evaluateProgress(count, state, 2), 1)
})


test('P1 arithmetic and round are finite pure functions', () => {
  const runtime = { n: 10, label: 'ten' }
  assert.equal(evaluateExpression({ op: 'add', args: [{ op: 'ref', key: 'n' }, 2] }, runtime), 12)
  assert.equal(evaluateExpression({ op: 'sub', args: [{ op: 'ref', key: 'n' }, 2] }, runtime), 8)
  assert.equal(evaluateExpression({ op: 'mul', args: [{ op: 'ref', key: 'n' }, 2] }, runtime), 20)
  assert.equal(evaluateExpression({ op: 'div', args: [{ op: 'ref', key: 'n' }, 4] }, runtime), 2.5)
  assert.equal(evaluateExpression({ op: 'round', args: [{ op: 'div', args: [1, 3] }, 2] }, runtime), 0.33)
  assert.throws(() => evaluateExpression({ op: 'div', args: [1, 0] }, runtime))
  assert.throws(() => evaluateExpression({ op: 'mul', args: [{ op: 'ref', key: 'label' }, 2] }, runtime))
  assert.deepEqual(runtime, { n: 10, label: 'ten' })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAnyVisualize } from '../lib/protocol-v2.js'

const valid = (value) => { const result = parseAnyVisualize(JSON.stringify(value)); assert.equal(result.ok, true, result.ok ? '' : result.reason); return result.config }
const invalid = (value) => assert.equal(parseAnyVisualize(JSON.stringify(value)).ok, false)
const numberState = (extra = {}) => ({ type: 'number', initial: 20, min: 0, max: 100, step: 1, ...extra })
const enumState = (extra = {}) => ({ type: 'enum', initial: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], ...extra })

test('number and enum states bind to their matching controls', () => {
  const config = valid({ version: 2, type: 'ui', state: { amount: numberState(), view: enumState() }, root: { type: 'box', children: [{ type: 'slider', label: '数量', bind: 'amount' }, { type: 'select', label: '视图', bind: 'view' }, { type: 'button', label: '重置', action: 'reset' }] } })
  assert.equal(config.state.amount.type, 'number')
  assert.equal(config.state.view.options.length, 2)
})

test('number declarations enforce range, step and initial alignment', () => {
  for (const state of [numberState({ min: 2, max: 1 }), numberState({ step: 0 }), numberState({ initial: -1 }), numberState({ initial: 101 }), numberState({ initial: 20.5 }), numberState({ min: 0, max: 1, step: 0.1, initial: 0.3 })]) {
    if (state.initial === 0.3) valid({ version: 2, type: 'ui', state: { n: state }, root: { type: 'slider', label: 'n', bind: 'n' } })
    else invalid({ version: 2, type: 'ui', state: { n: state }, root: { type: 'slider', label: 'n', bind: 'n' } })
  }
  invalid({ version: 2, type: 'ui', state: { n: { type: 'number', initial: 0 } }, root: { type: 'slider', label: 'n', bind: 'n' } })
})

test('enum options are bounded, unique and contain the initial value', () => {
  invalid({ version: 2, type: 'ui', state: { e: enumState({ initial: 'missing' }) }, root: { type: 'select', label: 'e', bind: 'e' } })
  invalid({ version: 2, type: 'ui', state: { e: enumState({ options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'Again' }] }) }, root: { type: 'select', label: 'e', bind: 'e' } })
  invalid({ version: 2, type: 'ui', state: { e: enumState({ options: Array.from({ length: 13 }, (_, i) => ({ value: `v${i}`, label: `V${i}` })) }) }, root: { type: 'select', label: 'e', bind: 'e' } })
})

test('control bindings and actions cannot be forged', () => {
  invalid({ version: 2, type: 'ui', state: { n: numberState() }, root: { type: 'select', label: 'wrong', bind: 'n' } })
  invalid({ version: 2, type: 'ui', state: { e: enumState() }, root: { type: 'slider', label: 'wrong', bind: 'e' } })
  invalid({ version: 2, type: 'ui', state: { e: enumState() }, root: { type: 'select', label: 'e', bind: 'e', options: [] } })
  invalid({ version: 2, type: 'ui', root: { type: 'button', label: 'submit', action: 'submit' } })
})

test('all arithmetic operations and round validate as numeric expressions', () => {
  for (const op of ['add', 'sub', 'mul', 'div']) {
    const config = valid({ version: 2, type: 'ui', root: { type: 'metric', label: op, value: { op, args: [10, 2] } } })
    assert.equal(config.root.value.op, op)
  }
  const rounded = valid({ version: 2, type: 'ui', root: { type: 'metric', label: 'rounded', value: { op: 'round', args: [{ op: 'div', args: [1, 3] }, 2] } } })
  assert.equal(rounded.root.value.op, 'round')
})

test('arithmetic rejects implicit conversion, arity and invalid rounding digits', () => {
  invalid({ version: 2, type: 'ui', root: { type: 'metric', label: 'x', value: { op: 'add', args: [1] } } })
  invalid({ version: 2, type: 'ui', root: { type: 'metric', label: 'x', value: { op: 'add', args: [1, 2, 3] } } })
  invalid({ version: 2, type: 'ui', root: { type: 'metric', label: 'x', value: { op: 'mul', args: ['2', 3] } } })
  invalid({ version: 2, type: 'ui', root: { type: 'metric', label: 'x', value: { op: 'round', args: [1.2, 7] } } })
  invalid({ version: 2, type: 'ui', root: { type: 'metric', label: 'x', value: { op: 'round', args: [1.2, { op: 'add', args: [1, 1] }] } } })
})

test('division by zero is a runtime-local failure rather than an invalid tree', () => {
  assert.equal(valid({ version: 2, type: 'ui', root: { type: 'metric', label: 'x', value: { op: 'div', args: [1, 0] } } }).root.value.op, 'div')
})

test('enum refs can drive string expressions without numeric coercion', () => {
  const config = valid({ version: 2, type: 'ui', state: { e: enumState() }, root: { type: 'text', text: { op: 'concat', args: ['当前：', { op: 'ref', key: 'e' }] } } })
  assert.equal(config.root.text.op, 'concat')
  invalid({ version: 2, type: 'ui', state: { e: enumState() }, root: { type: 'metric', label: 'x', value: { op: 'mul', args: [{ op: 'ref', key: 'e' }, 2] } } })
})

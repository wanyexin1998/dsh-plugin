import test from 'node:test'
import assert from 'node:assert/strict'
import { VISUALIZE_GUIDANCE, VISUALIZE_GUIDANCE_EXAMPLES, VISUALIZE_V2_GUIDANCE, VISUALIZE_V2_GUIDANCE_EXAMPLES, VISUALIZE_V2_P1_GUIDANCE, VISUALIZE_V2_P1_GUIDANCE_EXAMPLE, VISUALIZE_V2_P1_SELECT_EXAMPLE } from '../lib/guidance.js'
import { parseVisualize } from '../lib/protocol.js'
import { parseAnyVisualize } from '../lib/protocol-v2.js'

test('every model-facing example passes the actual V1 parser', () => {
  assert.equal(VISUALIZE_GUIDANCE_EXAMPLES.length, 9)
  for (const example of VISUALIZE_GUIDANCE_EXAMPLES) {
    const result = parseVisualize(JSON.stringify(example))
    assert.equal(result.ok, true, result.ok ? '' : result.reason)
    assert.ok(VISUALIZE_GUIDANCE.includes(JSON.stringify(example)))
  }
})

test('guidance includes chart variants, nulls, accuracy and component budget', () => {
  for (const text of ['bar', 'horizontal-bar', 'line', 'donut', 'funnel', 'flow', 'calculator', 'series', 'values', 'null', '不要编造数据', '最多 6 个组件', '禁止 {"type":"bar"}']) {
    assert.ok(VISUALIZE_GUIDANCE.includes(text))
  }
})


test('V2 P0 guidance examples are valid and P1 syntax stays separately disclosed', () => {
  for (const example of VISUALIZE_V2_GUIDANCE_EXAMPLES) {
    const result = parseAnyVisualize(JSON.stringify(example))
    assert.equal(result.ok, true, result.ok ? '' : result.reason)
    assert.ok(VISUALIZE_V2_GUIDANCE.includes(JSON.stringify(example)))
  }
  for (const text of ['box/row/column/grid', 'countTrue', 'concat', 'checkbox.bind', '局部状态', '临时状态']) assert.ok(VISUALIZE_V2_GUIDANCE.includes(text))
  for (const text of ['slider', 'select', 'round', 'enum']) assert.equal(VISUALIZE_V2_GUIDANCE.includes(text), false)
})


test('P1 guidance examples pass validation without implicit enum arithmetic', () => {
  for (const example of [VISUALIZE_V2_P1_GUIDANCE_EXAMPLE, VISUALIZE_V2_P1_SELECT_EXAMPLE]) {
    const result = parseAnyVisualize(JSON.stringify(example))
    assert.equal(result.ok, true, result.ok ? '' : result.reason)
    assert.ok(VISUALIZE_V2_P1_GUIDANCE.includes(JSON.stringify(example)))
  }
  for (const text of ['number/enum', 'slider/select/button', 'add/sub/mul/div', 'round', '模拟/假设', '不接受其他 action']) assert.ok(VISUALIZE_V2_P1_GUIDANCE.includes(text))
})

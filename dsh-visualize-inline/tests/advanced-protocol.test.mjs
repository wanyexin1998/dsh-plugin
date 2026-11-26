import test from 'node:test'
import assert from 'node:assert/strict'
import { parseVisualize } from '../lib/protocol.js'

const valid = (value) => {
  const result = parseVisualize(JSON.stringify(value))
  assert.equal(result.ok, true, result.ok ? '' : result.reason)
  return result.config
}
const invalid = (value) => assert.equal(parseVisualize(typeof value === 'string' ? value : JSON.stringify(value)).ok, false)
const donut = (data = [{ label: 'A', value: 60 }, { label: 'B', value: 40 }]) => ({ version: 1, type: 'chart', chart: 'donut', data })
const funnel = (data = [{ label: '访问', value: 1000 }, { label: '注册', value: 400 }]) => ({ version: 1, type: 'chart', chart: 'funnel', data })

test('donut and funnel accept nonnegative ordered data and explicit null', () => {
  assert.deepEqual(valid(donut([{ label: 'A', value: 60 }, { label: '缺失', value: null }, { label: 'B', value: 40 }])).data.map((point) => point.label), ['A', '缺失', 'B'])
  assert.equal(valid(funnel()).chart, 'funnel')
  assert.equal(valid(funnel([{ label: '零起始', value: 0 }, { label: 'B', value: 1 }])).data[0].value, 0)
})

test('donut and funnel reject negative, all-zero and excessive categories', () => {
  invalid(donut([{ label: 'A', value: -1 }, { label: 'B', value: 2 }]))
  invalid(funnel([{ label: 'A', value: -1 }]))
  invalid(donut([{ label: 'A', value: null }]))
  invalid(donut([{ label: 'A', value: 0 }]))
  invalid(donut(Array.from({ length: 13 }, (_, index) => ({ label: `L${index}`, value: 1 }))))
})

test('multi-series bar and line preserve series and values including null', () => {
  for (const chart of ['bar', 'line']) {
    const config = valid({ version: 1, type: 'chart', chart, series: ['实际', '预测'], data: [{ label: '1月', values: [100, 110] }, { label: '2月', values: [null, 125] }] })
    assert.deepEqual(config.series, ['实际', '预测'])
    assert.deepEqual(config.data[1].values, [null, 125])
  }
})

test('multi-series enforces chart kind, series count, uniqueness and values length', () => {
  const base = { version: 1, type: 'chart', chart: 'bar', series: ['A', 'B'], data: [{ label: 'L', values: [1, 2] }] }
  invalid({ ...base, chart: 'horizontal-bar' })
  invalid({ ...base, series: ['A'] })
  invalid({ ...base, series: ['A', 'B', 'C', 'D', 'E'], data: [{ label: 'L', values: [1, 2, 3, 4, 5] }] })
  invalid({ ...base, series: ['A', 'A'] })
  invalid({ ...base, data: [{ label: 'L', values: [1] }] })
  invalid({ ...base, data: [{ label: 'L', value: 1 }] })
  invalid({ ...base, data: [{ label: 'L', values: [1, 2], extra: true }] })
})

test('metric groups support one to six strict metric items and exact strings', () => {
  const config = valid({ version: 1, type: 'metric-group', title: '核心指标', metrics: [{ label: '收入', value: 100 }, { label: '精确值', value: '12345678901234567890.123400' }] })
  assert.equal(config.metrics[1].value, '12345678901234567890.123400')
  invalid({ version: 1, type: 'metric-group', metrics: [] })
  invalid({ version: 1, type: 'metric-group', metrics: Array.from({ length: 7 }, (_, index) => ({ label: `L${index}`, value: index })) })
  invalid({ version: 1, type: 'metric-group', metrics: [{ label: 'A', value: 1 }, { label: 'A', value: 2 }] })
  invalid({ version: 1, type: 'metric-group', metrics: [{ label: 'A', value: 1, type: 'metric' }] })
})

test('flow accepts DAG branches and text labels', () => {
  const config = valid({ version: 1, type: 'flow', title: '审批', nodes: [{ id: 'a', label: '提交', kind: 'start' }, { id: 'b', label: '通过？', kind: 'decision' }, { id: 'c', label: '完成', kind: 'end' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: '通过' }] })
  assert.equal(config.nodes[1].kind, 'decision')
  assert.equal(config.edges[1].label, '通过')
})

test('flow rejects cycles, self loops, bad references and duplicate identities', () => {
  const nodes = [{ id: 'a', label: 'A', kind: 'start' }, { id: 'b', label: 'B', kind: 'end' }]
  invalid({ version: 1, type: 'flow', nodes, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] })
  invalid({ version: 1, type: 'flow', nodes, edges: [{ from: 'a', to: 'a' }] })
  invalid({ version: 1, type: 'flow', nodes, edges: [{ from: 'a', to: 'missing' }] })
  invalid({ version: 1, type: 'flow', nodes: [nodes[0], nodes[0]], edges: [] })
  invalid({ version: 1, type: 'flow', nodes, edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }] })
  invalid({ version: 1, type: 'flow', nodes: [{ id: 'a', label: 'A', kind: 'unknown' }], edges: [] })
})

test('calculator supports only bounded arithmetic and never accepts expressions', () => {
  for (const [operation, operands] of [['add', [1, 2, 3]], ['subtract', [10, 3]], ['multiply', [2, 3, 4]], ['divide', [10, 4]]]) {
    assert.deepEqual(valid({ version: 1, type: 'calculator', label: '计算', operation, operands }).operands, operands)
  }
  invalid({ version: 1, type: 'calculator', label: '计算', operation: 'divide', operands: [1, 0] })
  invalid({ version: 1, type: 'calculator', label: '计算', operation: 'subtract', operands: [1, 2, 3] })
  invalid({ version: 1, type: 'calculator', label: '计算', operation: 'pow', operands: [2, 3] })
  invalid({ version: 1, type: 'calculator', label: '计算', operation: 'add', operands: [1], expression: 'alert(1)' })
  invalid({ version: 1, type: 'calculator', label: '计算', operation: 'add', operands: ['1', 2] })
})

test('bar remains a chart kind and can never become a top-level type', () => {
  invalid({ version: 1, type: 'bar', data: [{ label: 'A', value: 1 }] })
})

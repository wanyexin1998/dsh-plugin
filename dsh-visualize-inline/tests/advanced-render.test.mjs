import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot } from 'react-dom/client'

const act = React.act
const require = createRequire(import.meta.url)
const { VisualizeFence } = require('../lib/client.test.cjs')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'HTMLElement', 'SVGElement', 'Node', 'Event', 'MouseEvent', 'FocusEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let container
let root

function render(config) {
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(React.createElement(VisualizeFence, { lang: 'visualize', code: JSON.stringify(config), streaming: false })))
}
test.afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
  root = null
  container = null
})

test('donut renders exact total, legend percentages and keyboard tips', () => {
  render({ version: 1, type: 'chart', chart: 'donut', title: '占比', unit: '人', data: [{ label: 'A', value: 60 }, { label: 'B', value: 40 }] })
  assert.equal(container.querySelectorAll('.dsh-vi-donut-segment').length, 2)
  assert.ok(container.textContent.includes('100'))
  assert.ok(container.textContent.includes('60%'))
  assert.ok(container.textContent.includes('40%'))
  const segment = container.querySelector('.dsh-vi-donut-segment')
  act(() => segment.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true })))
  assert.equal(container.querySelector('.dsh-vi-data-tip').textContent, 'A：60 人，60%')
})

test('donut null values stay explicit and are excluded from segments', () => {
  render({ version: 1, type: 'chart', chart: 'donut', data: [{ label: 'A', value: 100 }, { label: '未知', value: null }] })
  assert.equal(container.querySelectorAll('.dsh-vi-donut-segment').length, 1)
  assert.ok(container.textContent.includes('未计入合计'))
})

test('funnel preserves stage order and shows previous-stage conversion', () => {
  render({ version: 1, type: 'chart', chart: 'funnel', data: [{ label: '访问', value: 1000 }, { label: '注册', value: 400 }, { label: '付费', value: 100 }] })
  const rows = [...container.querySelectorAll('.dsh-vi-funnel-row')]
  assert.deepEqual(rows.map((row) => row.querySelector('span').textContent), ['访问', '注册', '付费'])
  assert.ok(rows[1].textContent.includes('40%'))
  assert.ok(rows[2].textContent.includes('25%'))
})

test('multi-series bars render every series and accessible table columns', () => {
  render({ version: 1, type: 'chart', chart: 'bar', title: '实际与预测', series: ['实际', '预测'], data: [{ label: '1月', values: [100, 110] }, { label: '2月', values: [120, 125] }] })
  assert.equal(container.querySelectorAll('.dsh-vi-multi-series [role="img"]').length, 4)
  assert.ok(container.querySelector('.dsh-vi-series-legend').textContent.includes('实际'))
  const button = container.querySelector('.dsh-vi-table-toggle')
  act(() => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  assert.equal(container.querySelectorAll('thead th').length, 3)
  assert.ok(container.querySelector('table').textContent.includes('125'))
})

test('multi-series lines have independent styles and null breaks', () => {
  render({ version: 1, type: 'chart', chart: 'line', series: ['实际', '预测'], data: [{ label: '1月', values: [100, 110] }, { label: '2月', values: [null, 120] }, { label: '3月', values: [130, 130] }] })
  assert.equal(container.querySelectorAll('.dsh-vi-line').length, 3)
  assert.notEqual(container.querySelectorAll('.dsh-vi-line')[0].getAttribute('style'), container.querySelectorAll('.dsh-vi-line')[2].getAttribute('style'))
})

test('metric group lays out up to three columns without inventing metrics', () => {
  render({ version: 1, type: 'metric-group', title: '核心指标', metrics: [{ label: '收入', value: 100, unit: '元' }, { label: '用户', value: 80, unit: '人' }, { label: '完成率', value: '95.00', unit: '%' }] })
  assert.equal(container.querySelectorAll('.dsh-vi-metric').length, 3)
  assert.equal(container.querySelector('.dsh-vi-metric-grid').style.gridTemplateColumns, 'repeat(3, minmax(0, 1fr))')
  assert.ok(container.textContent.includes('95.00'))
  assert.ok(container.textContent.includes('%'))
})

test('flow renders decision nodes, arrows, branch labels and list alternative', () => {
  render({ version: 1, type: 'flow', title: '审批流程', nodes: [{ id: 'a', label: '提交', kind: 'start' }, { id: 'b', label: '通过？', kind: 'decision' }, { id: 'c', label: '完成', kind: 'end' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: '通过' }] })
  assert.equal(container.querySelectorAll('.dsh-vi-flow-node').length, 3)
  assert.equal(container.querySelectorAll('polygon').length, 1)
  assert.equal(container.querySelectorAll('.dsh-vi-flow-edge').length, 2)
  const button = container.querySelector('.dsh-vi-table-toggle')
  act(() => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  assert.ok(container.querySelector('.dsh-vi-flow-list').textContent.includes('提交 → 通过？'))
  assert.ok(container.querySelector('.dsh-vi-flow-list').textContent.includes('通过？ → 完成（通过）'))
})

test('flow labels are inert text', () => {
  render({ version: 1, type: 'flow', nodes: [{ id: 'a', label: '<img src=x onerror=alert(1)>', kind: 'start' }], edges: [] })
  assert.equal(container.querySelector('img'), null)
  assert.ok(container.textContent.includes('<img src=x onerror=alert(1)>'))
})

test('calculator computes bounded operations and preserves units', () => {
  render({ version: 1, type: 'calculator', label: '剩余预算', operation: 'subtract', operands: [1000, 350], unit: '元' })
  assert.ok(container.textContent.includes('1000 − 350'))
  assert.ok(container.textContent.includes('= 650'))
  assert.ok(container.textContent.includes('元'))
})

test('calculator avoids binary floating point display noise', () => {
  render({ version: 1, type: 'calculator', label: '合计', operation: 'add', operands: [0.1, 0.2] })
  assert.ok(container.textContent.includes('= 0.3'))
  assert.equal(container.textContent.includes('0.30000000000000004'), false)
})

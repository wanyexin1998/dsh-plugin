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
for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Node', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let container
let root

const parameterSpec = () => ({ version: 2, type: 'ui', state: {
  customers: { type: 'number', initial: 20, min: 0, max: 100, step: 1 },
  price: { type: 'number', initial: 500, min: 100, max: 1000, step: 100 },
  view: { type: 'enum', initial: 'summary', options: [{ value: 'summary', label: '摘要' }, { value: 'detail', label: '详细说明' }] },
}, root: { type: 'box', children: [
  { type: 'slider', label: '客户数', bind: 'customers', unit: '人' },
  { type: 'slider', label: '客单价', bind: 'price', unit: '元' },
  { type: 'select', label: '阅读方式', bind: 'view' },
  { type: 'text', text: { op: 'concat', args: ['当前选择：', { op: 'ref', key: 'view' }] } },
  { type: 'metric', label: '预计收入', value: { op: 'mul', args: [{ op: 'ref', key: 'customers' }, { op: 'ref', key: 'price' }] }, unit: '元' },
  { type: 'metric', label: '人均分摊', value: { op: 'round', args: [{ op: 'div', args: [10000, { op: 'ref', key: 'customers' }] }, 2] }, unit: '元' },
  { type: 'button', label: '重置', action: 'reset' },
] } })

function render(spec = parameterSpec(), streaming = false) {
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(React.createElement(VisualizeFence, { lang: 'visualize', code: JSON.stringify(spec), streaming })))
}
function setInput(input, value) {
  const prototype = input.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value)
  act(() => {
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}
function click(node) { act(() => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))) }
test.afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); root = null; container = null })

test('sliders and select update only their derived values', () => {
  render()
  const ranges = container.querySelectorAll('input[type="range"]')
  const select = container.querySelector('select')
  assert.ok(container.textContent.includes('10000'))
  setInput(ranges[0], '30')
  assert.ok(container.textContent.includes('15000'))
  setInput(ranges[1], '800')
  assert.ok(container.textContent.includes('24000'))
  setInput(select, 'detail')
  assert.ok(container.textContent.includes('当前选择：detail'))
  assert.ok(container.textContent.includes('24000'))
})

test('reset restores every state declaration in the current fence', () => {
  render()
  const ranges = container.querySelectorAll('input[type="range"]')
  setInput(ranges[0], '30')
  setInput(ranges[1], '800')
  setInput(container.querySelector('select'), 'detail')
  click(container.querySelector('.dsh-vi-reset'))
  assert.equal(ranges[0].value, '20')
  assert.equal(ranges[1].value, '500')
  assert.equal(container.querySelector('select').value, 'summary')
  assert.ok(container.textContent.includes('10000'))
})

test('division by zero affects only the dependent metric and recovers', () => {
  render()
  const customers = container.querySelectorAll('input[type="range"]')[0]
  setInput(customers, '0')
  assert.ok(container.querySelector('.dsh-vi-derived-error').textContent.includes('人均分摊：无法计算'))
  assert.ok(container.textContent.includes('预计收入'))
  assert.ok(container.textContent.includes('0'))
  setInput(customers, '1')
  assert.equal(container.querySelector('.dsh-vi-derived-error'), null)
  assert.ok(container.textContent.includes('10000'))
})

test('round produces display-oriented numeric output', () => {
  render({ version: 2, type: 'ui', root: { type: 'metric', label: '平均值', value: { op: 'round', args: [{ op: 'div', args: [1, 3] }, 2] } } })
  assert.ok(container.textContent.includes('0.33'))
})

test('runtime arithmetic overflow is local and never displays stale output', () => {
  render({ version: 2, type: 'ui', root: { type: 'metric', label: '溢出', value: { op: 'mul', args: [9007199254740991, 2] } } })
  assert.ok(container.querySelector('.dsh-vi-derived-error').textContent.includes('溢出：无法计算'))
})

test('all P1 controls remain disabled during streaming preview', () => {
  render(parameterSpec(), true)
  assert.equal([...container.querySelectorAll('input,select,button')].every((control) => control.disabled), true)
})

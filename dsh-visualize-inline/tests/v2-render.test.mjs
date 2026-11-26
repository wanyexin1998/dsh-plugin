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
for (const key of ['window', 'document', 'HTMLElement', 'SVGElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'FocusEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let container
let root

const tasks = () => ({ version: 2, type: 'ui', state: { task1: { type: 'boolean', initial: true }, task2: { type: 'boolean', initial: false } }, root: { type: 'box', variant: 'card', padding: 'md', children: [
  { type: 'title', text: '验收任务' },
  { type: 'text', text: { op: 'concat', args: [{ op: 'countTrue', args: [{ op: 'ref', key: 'task1' }, { op: 'ref', key: 'task2' }] }, ' / 2 已完成'] } },
  { type: 'progress', label: '完成度', value: { op: 'countTrue', args: [{ op: 'ref', key: 'task1' }, { op: 'ref', key: 'task2' }] }, target: 2 },
  { type: 'checkbox', label: '插件开发', bind: 'task1' },
  { type: 'checkbox', label: '兼容测试', bind: 'task2' },
] } })

function render(config, streaming = false) {
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  const code = JSON.stringify(config)
  act(() => root.render(React.createElement(VisualizeFence, { lang: 'visualize', code, streaming })))
  return { update(next = config, nextStreaming = streaming) { act(() => root.render(React.createElement(VisualizeFence, { lang: 'visualize', code: JSON.stringify(next), streaming: nextStreaming }))) } }
}
function click(input) { act(() => input.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))) }
test.afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); root = null; container = null })

test('dual-column comparison uses only generic primitives', () => {
  render({ version: 2, type: 'ui', root: { type: 'grid', columns: 2, children: [{ type: 'box', variant: 'card', children: [{ type: 'icon', name: 'file-text' }, { type: 'title', text: 'Markdown' }, { type: 'divider' }] }, { type: 'box', variant: 'card', children: [{ type: 'icon', name: 'blocks' }, { type: 'title', text: 'UI 树' }] }] } })
  assert.equal(container.querySelectorAll('.dsh-vi-box-card').length, 2)
  assert.equal(container.querySelectorAll('.dsh-vi-icon').length, 2)
  assert.equal(container.querySelector('.dsh-vi-grid').style.getPropertyValue('--dsh-vi-grid-columns'), '2')
})

test('architecture composes boxes and controlled SVG arrows', () => {
  render({ version: 2, type: 'ui', root: { type: 'box', children: [{ type: 'title', text: 'Agent' }, { type: 'svg', viewBox: [0, 0, 320, 36], height: 'sm', shapes: [{ type: 'line', x1: 160, y1: 0, x2: 160, y2: 32, arrowEnd: true }] }, { type: 'box', variant: 'subtle', children: [{ type: 'title', text: 'DSH Runtime' }] }] } })
  assert.equal(container.querySelectorAll('.dsh-vi-graphics line').length, 1)
  assert.ok(container.querySelector('.dsh-vi-graphics line').getAttribute('marker-end').includes('url(#'))
  assert.equal(container.querySelector('script'), null)
})

test('valid streaming V2 is read-only and settlement enables local interaction', () => {
  const view = render(tasks(), true)
  const inputs = container.querySelectorAll('input[type="checkbox"]')
  assert.equal([...inputs].every((input) => input.disabled), true)
  assert.ok(container.textContent.includes('只读预览'))
  view.update(tasks(), false)
  assert.equal([...container.querySelectorAll('input')].every((input) => !input.disabled), true)
  assert.ok(container.textContent.includes('本地交互'))
})

test('checkbox, count text and progress stay synchronized through arbitrary changes', () => {
  render(tasks())
  const inputs = container.querySelectorAll('input')
  assert.ok(container.textContent.includes('1 / 2 已完成'))
  click(inputs[1])
  assert.ok(container.textContent.includes('2 / 2 已完成'))
  assert.equal(container.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '100')
  click(inputs[0])
  assert.ok(container.textContent.includes('1 / 2 已完成'))
  assert.equal(container.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '50')
  click(inputs[1])
  assert.ok(container.textContent.includes('0 / 2 已完成'))
})

test('ordinary same-code rerenders preserve state but code changes reinitialize it', () => {
  const view = render(tasks())
  const input = container.querySelectorAll('input')[1]
  click(input)
  assert.ok(container.textContent.includes('2 / 2 已完成'))
  view.update(tasks(), false)
  assert.ok(container.textContent.includes('2 / 2 已完成'))
  const changed = tasks()
  changed.root.children[0].text = '新任务'
  view.update(changed, false)
  assert.ok(container.textContent.includes('1 / 2 已完成'))
})

test('two fences never share local state', () => {
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  const code = JSON.stringify(tasks())
  act(() => root.render(React.createElement(React.Fragment, null, React.createElement(VisualizeFence, { key: 1, lang: 'visualize', code, streaming: false }), React.createElement(VisualizeFence, { key: 2, lang: 'visualize', code, streaming: false }))))
  const secondInputs = container.querySelectorAll('.dsh-vi-ui')[1].querySelectorAll('input')
  click(secondInputs[1])
  const texts = [...container.querySelectorAll('.dsh-vi-text')].map((node) => node.textContent)
  assert.deepEqual(texts, ['1 / 2 已完成', '2 / 2 已完成'])
})

test('V2 chart children reuse V1 rendering', () => {
  render({ version: 2, type: 'ui', root: { type: 'box', children: [{ type: 'chart', chart: 'bar', data: [{ label: 'A', value: 1 }] }] } })
  assert.equal(container.querySelectorAll('.dsh-vi-bar').length, 1)
})

test('invalid V2 controls fall back without stale UI', () => {
  const view = render(tasks())
  assert.equal(container.querySelectorAll('input').length, 2)
  view.update({ version: 2, type: 'ui', root: { type: 'select', label: 'x', bind: 'x' } }, false)
  assert.ok(container.querySelector('.dsh-vi-fallback'))
  assert.equal(container.querySelectorAll('input').length, 0)
})

test('UI text remains inert under HTML-like input', () => {
  render({ version: 2, type: 'ui', root: { type: 'text', text: '<img src=x onerror=alert(1)>' } })
  assert.equal(container.querySelector('img'), null)
  assert.ok(container.textContent.includes('<img src=x onerror=alert(1)>'))
})

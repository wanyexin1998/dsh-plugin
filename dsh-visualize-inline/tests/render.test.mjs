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
for (const key of ['window', 'document', 'HTMLElement', 'SVGElement', 'Node', 'Event', 'MouseEvent', 'FocusEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root

function render(code, streaming = false, children = null) {
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  const element = React.createElement(VisualizeFence, { lang: 'visualize', code, streaming }, children)
  act(() => root.render(element))
  return {
    update(nextCode, nextStreaming = streaming, nextChildren = children) {
      act(() => root.render(React.createElement(VisualizeFence, { lang: 'visualize', code: nextCode, streaming: nextStreaming }, nextChildren)))
    },
  }
}

const metric = JSON.stringify({ version: 1, type: 'metric', label: '累计现金流', value: 2450, unit: '万元', note: '目标 3000 万元' })
const chart = (kind = 'bar', data = [{ label: '9月', value: 730 }, { label: '10月', value: 950 }, { label: '11月', value: 680 }]) => JSON.stringify({ version: 1, type: 'chart', chart: kind, title: '月度现金流', unit: '万元', data })

test.afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
  root = null
  container = null
})

test('streaming partial JSON shows only a lightweight placeholder', () => {
  render('{"version":1,"type":"metric"', true)
  assert.ok(container.querySelector('[role="status"]'))
  assert.equal(container.textContent.includes('{"version"'), false)
  assert.equal(container.querySelector('.dsh-vi-metric'), null)
})

test('a valid configuration previews before the document settles and then loses its preview badge', () => {
  const view = render(metric, true)
  assert.equal(container.querySelector('.dsh-vi-metric-value > span').textContent, '2450')
  assert.equal(container.querySelector('.dsh-vi-preview').textContent, '实时预览')
  view.update(metric, false)
  assert.equal(container.querySelector('.dsh-vi-preview'), null)
  assert.equal(container.querySelector('.dsh-vi-metric-value > span').textContent, '2450')
})

test('valid-to-invalid streaming never leaves stale numbers visible', () => {
  const view = render(metric, true)
  assert.ok(container.textContent.includes('2450'))
  view.update('{"version":1,', true)
  assert.ok(container.querySelector('[role="status"]'))
  assert.equal(container.textContent.includes('2450'), false)
})

test('settled invalid JSON preserves native children and shows a concise notice', () => {
  const native = React.createElement('pre', { 'data-native': 'code' }, 'original source')
  render('{bad json', false, native)
  assert.equal(container.querySelector('[data-native="code"]').textContent, 'original source')
  assert.ok(container.querySelector('[role="alert"]').textContent.includes('已保留原始代码'))
})

test('metric displays exact numeric strings, unit and note without invented trends', () => {
  render(JSON.stringify({ version: 1, type: 'metric', label: '精确值', value: '001.2300', unit: '元', note: '仅展示' }).replace('001.2300', '12345678901234567890.123400'))
  assert.ok(container.textContent.includes('12345678901234567890.123400'))
  assert.ok(container.textContent.includes('元'))
  assert.ok(container.textContent.includes('仅展示'))
  assert.equal(container.textContent.includes('同比'), false)
  assert.equal(container.textContent.includes('环比'), false)
})

test('progress keeps over-target percentage while filling the track', () => {
  render(JSON.stringify({ version: 1, type: 'progress', label: 'Q4 目标达成率', value: 3750, target: 3000, unit: '万元' }), false)
  assert.ok(container.textContent.includes('125%'))
  assert.equal(container.querySelector('.dsh-vi-progress-fill').style.width, '100%')
  const track = container.querySelector('[role="progressbar"]')
  assert.equal(track.getAttribute('aria-valuenow'), '100')
  assert.ok(track.getAttribute('aria-valuetext').includes('3750 万元 / 3000 万元'))
})

test('bar chart draws all values in source order with title and shared unit', () => {
  render(chart())
  assert.equal(container.querySelectorAll('.dsh-vi-bar').length, 3)
  const labels = [...container.querySelectorAll('.dsh-vi-chart-svg > g ~ text, .dsh-vi-chart-svg text title')]
  assert.ok(container.textContent.includes('月度现金流'))
  assert.ok(container.textContent.includes('万元'))
  const interactions = [...container.querySelectorAll('[role="img"]')]
  assert.deepEqual(interactions.map((node) => node.getAttribute('aria-label')), ['9月：730 万元', '10月：950 万元', '11月：680 万元'])
  assert.equal(labels.length > 0, true)
})

test('negative, zero and null bars use a zero axis and explicit missing text', () => {
  render(chart('bar', [{ label: '负值', value: -20 }, { label: '零', value: 0 }, { label: '缺失', value: null }]))
  assert.ok(container.querySelector('.dsh-vi-zero'))
  assert.equal(container.querySelectorAll('.dsh-vi-bar').length, 2)
  assert.ok(container.textContent.includes('无数据'))
  assert.equal(container.querySelector('[aria-label="缺失：无数据"]') !== null, true)
})

test('line null values break the path and remain keyboard-readable', () => {
  render(chart('line', [{ label: 'A', value: 1 }, { label: 'B', value: null }, { label: 'C', value: 2 }, { label: 'D', value: 3 }]))
  assert.equal(container.querySelectorAll('.dsh-vi-line').length, 2)
  assert.equal(container.querySelectorAll('.dsh-vi-point').length, 3)
  assert.equal(container.querySelector('[aria-label="B：无数据"]') !== null, true)
})

test('horizontal bars support negative values and keep a readable mobile canvas', () => {
  render(chart('horizontal-bar', [{ label: '很长很长的中文类别标签', value: -10 }, { label: 'B', value: 30 }]))
  const svg = container.querySelector('.dsh-vi-chart-svg')
  assert.equal(svg.getAttribute('width'), '640')
  assert.equal(container.querySelectorAll('.dsh-vi-bar').length, 2)
  assert.ok(container.querySelector('.dsh-vi-chart-scroll'))
  assert.ok(container.querySelector('.dsh-vi-zero'))
})

test('focus exposes a data tip without relying only on color', () => {
  render(chart())
  const point = container.querySelector('[role="img"]')
  act(() => point.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true })))
  const tip = container.querySelector('.dsh-vi-data-tip')
  assert.equal(tip.getAttribute('data-active'), 'true')
  assert.equal(tip.textContent, '9月：730 万元')
})

test('data-table alternative toggles accessibly and keeps null explicit', () => {
  render(chart('line', [{ label: 'A', value: 1 }, { label: 'B', value: null }]))
  const button = container.querySelector('.dsh-vi-table-toggle')
  assert.equal(button.getAttribute('aria-expanded'), 'false')
  act(() => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  assert.equal(button.getAttribute('aria-expanded'), 'true')
  assert.equal(container.querySelectorAll('tbody tr').length, 2)
  assert.ok(container.querySelector('tbody').textContent.includes('无数据'))
  act(() => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  assert.equal(container.querySelector('table'), null)
})

test('HTML and URL strings render as inert text', () => {
  const label = '<img src=x onerror=alert(1)> https://example.com'
  render(JSON.stringify({ version: 1, type: 'metric', label, value: 1 }))
  assert.equal(container.querySelector('img'), null)
  assert.equal(container.querySelector('script'), null)
  assert.ok(container.textContent.includes(label))
})

test('six maximum-size charts remain bounded and render every interactive datum', () => {
  const data = Array.from({ length: 120 }, (_, index) => ({ label: `L${index}`, value: index % 11 === 0 ? null : index - 60 }))
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  const elements = Array.from({ length: 6 }, (_, index) => React.createElement(VisualizeFence, { key: index, lang: 'visualize', code: chart('line', data), streaming: false }))
  act(() => root.render(React.createElement(React.Fragment, null, ...elements)))
  assert.equal(container.querySelectorAll('.dsh-vi-chart').length, 6)
  assert.equal(container.querySelectorAll('[role="img"]').length, 720)
})

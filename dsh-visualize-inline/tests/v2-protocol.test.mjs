import test from 'node:test'
import assert from 'node:assert/strict'
import { parseVisualize } from '../lib/protocol.js'
import { parseAnyVisualize } from '../lib/protocol-v2.js'
import { VISUALIZE_V2_GUIDANCE_EXAMPLES } from '../lib/guidance.js'

const valid = (value) => {
  const result = parseAnyVisualize(JSON.stringify(value))
  assert.equal(result.ok, true, result.ok ? '' : result.reason)
  return result.config
}
const invalid = (value) => assert.equal(parseAnyVisualize(typeof value === 'string' ? value : JSON.stringify(value)).ok, false)
const text = (value = 'text') => ({ type: 'text', text: value })

test('V1 keeps identical parsing through the version dispatcher', () => {
  const value = { version: 1, type: 'chart', chart: 'bar', data: [{ label: 'A', value: 1 }] }
  assert.deepEqual(parseAnyVisualize(JSON.stringify(value)), parseVisualize(JSON.stringify(value)))
})

test('all model-facing V2 examples pass the actual validator', () => {
  assert.equal(VISUALIZE_V2_GUIDANCE_EXAMPLES.length, 3)
  for (const example of VISUALIZE_V2_GUIDANCE_EXAMPLES) assert.equal(valid(example).version, 2)
})

test('layout, content, metric, chart and all controlled SVG shapes compose', () => {
  const config = valid({ version: 2, type: 'ui', root: { type: 'column', children: [
    { type: 'row', align: 'center', children: [{ type: 'title', text: 'Title' }, { type: 'spacer' }, { type: 'icon', name: 'workflow' }] },
    { type: 'divider' },
    { type: 'metric', label: '指标', value: 123, unit: '元' },
    { type: 'chart', chart: 'bar', data: [{ label: 'A', value: 1 }] },
    { type: 'svg', viewBox: [0, 0, 100, 100], shapes: [{ type: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }, { type: 'polyline', points: [[0, 0], [5, 5]] }, { type: 'rect', x: 1, y: 1, width: 10, height: 10 }, { type: 'circle', cx: 5, cy: 5, r: 2 }, { type: 'text', x: 0, y: 10, text: 'label' }] },
  ] } })
  assert.equal(config.root.children.length, 5)
})

test('unknown versions, node types, props and raw web content are rejected', () => {
  invalid({ version: 3, type: 'ui', root: text() })
  invalid({ version: 2, type: 'ui', root: { type: 'unknown' } })
  invalid({ version: 2, type: 'ui', root: { ...text(), style: { color: 'red' } } })
  invalid({ version: 2, type: 'ui', root: { ...text(), className: 'x' } })
  invalid({ version: 2, type: 'ui', root: { type: 'html', html: '<script>alert(1)</script>' } })
  invalid({ version: 2, type: 'ui', root: { type: 'select', label: 'x', bind: 'x' } })
  invalid('{"version":2,"version":2,"type":"ui","root":{"type":"divider"}}')
})

test('container arity, grid columns and spacer placement are strict', () => {
  invalid({ version: 2, type: 'ui', root: { type: 'grid', columns: 0, children: [] } })
  invalid({ version: 2, type: 'ui', root: { type: 'grid', columns: 5, children: [] } })
  invalid({ version: 2, type: 'ui', root: { type: 'grid', columns: 1.5, children: [] } })
  invalid({ version: 2, type: 'ui', root: { type: 'box', children: [{ type: 'spacer' }] } })
  invalid({ version: 2, type: 'ui', root: { type: 'row', children: Array.from({ length: 21 }, () => text()) } })
})

test('UI node count and depth are bounded', () => {
  invalid({ version: 2, type: 'ui', root: { type: 'box', children: Array.from({ length: 5 }, () => ({ type: 'box', children: Array.from({ length: 20 }, () => text()) })) } })
  let root = text()
  for (let index = 0; index < 10; index += 1) root = { type: 'box', children: [root] }
  invalid({ version: 2, type: 'ui', root })
})

test('state keys and declarations remain strict', () => {
  invalid({ version: 2, type: 'ui', state: { '1bad': { type: 'boolean', initial: false } }, root: text() })
  invalid({ version: 2, type: 'ui', state: { a: { type: 'boolean', initial: 0 } }, root: text() })
  invalid({ version: 2, type: 'ui', state: { a: { type: 'number', initial: 0 } }, root: text() })
  invalid({ version: 2, type: 'ui', state: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`s${i}`, { type: 'boolean', initial: false }])), root: text() })
  invalid({ version: 2, type: 'ui', root: { type: 'checkbox', label: 'A', bind: 'missing' } })
})

test('expressions enforce references, result types and operation schemas', () => {
  invalid({ version: 2, type: 'ui', root: text({ op: 'ref', key: 'missing' }) })
  invalid({ version: 2, type: 'ui', state: { a: { type: 'boolean', initial: false } }, root: text({ op: 'ref', key: 'a' }) })
  invalid({ version: 2, type: 'ui', root: text({ op: 'countTrue', args: [true, 1] }) })
  invalid({ version: 2, type: 'ui', root: text({ op: 'concat', args: [] }) })
  invalid({ version: 2, type: 'ui', root: text({ op: 'mul', args: [1, 2] }) })
  invalid({ version: 2, type: 'ui', state: { a: { type: 'boolean', initial: false } }, root: { type: 'progress', label: 'x', value: { op: 'ref', key: 'a' }, target: 1 } })
})

test('expression operation count and depth are bounded', () => {
  const nested = { op: 'concat', args: Array.from({ length: 20 }, () => ({ op: 'concat', args: ['a', 'b'] })) }
  invalid({ version: 2, type: 'ui', root: text(nested) })
  let deep = 'x'
  for (let index = 0; index < 8; index += 1) deep = { op: 'concat', args: [deep] }
  invalid({ version: 2, type: 'ui', root: text(deep) })
})

test('SVG rejects raw paths, bad coordinates and excessive shapes', () => {
  invalid({ version: 2, type: 'ui', root: { type: 'svg', viewBox: [0, 0, 10, 10], shapes: [{ type: 'path', d: 'M0 0' }] } })
  invalid({ version: 2, type: 'ui', root: { type: 'svg', viewBox: [0, 0, 0, 10], shapes: [] } })
  invalid({ version: 2, type: 'ui', root: { type: 'svg', viewBox: [0, 0, 10, 10], shapes: [{ type: 'line', x1: 10001, y1: 0, x2: 0, y2: 0 }] } })
  invalid({ version: 2, type: 'ui', root: { type: 'svg', viewBox: [0, 0, 10, 10], shapes: [{ type: 'polyline', points: Array.from({ length: 33 }, () => [0, 0]) }] } })
  invalid({ version: 2, type: 'ui', root: { type: 'svg', viewBox: [0, 0, 10, 10], shapes: Array.from({ length: 121 }, () => ({ type: 'circle', cx: 1, cy: 1, r: 1 })) } })
})

test('cumulative chart data is bounded across the UI tree', () => {
  const data = Array.from({ length: 100 }, (_, index) => ({ label: `L${index}`, value: index }))
  invalid({ version: 2, type: 'ui', root: { type: 'box', children: Array.from({ length: 4 }, () => ({ type: 'chart', chart: 'bar', data })) } })
})

test('V2 chart nodes retain V1 discriminator and data semantics', () => {
  invalid({ version: 2, type: 'ui', root: { type: 'chart', chart: 'bar', data: [{ label: 'A', value: 1, extra: true }] } })
  invalid({ version: 2, type: 'ui', root: { type: 'bar', data: [{ label: 'A', value: 1 }] } })
})

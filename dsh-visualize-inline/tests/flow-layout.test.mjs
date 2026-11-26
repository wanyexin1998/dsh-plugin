import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutFlow } from '../lib/flow-layout.js'

test('flow layout assigns topological columns and deterministic rows', () => {
  const config = { version: 1, type: 'flow', nodes: [{ id: 'a', label: 'A', kind: 'start' }, { id: 'b', label: 'B', kind: 'decision' }, { id: 'c', label: 'C', kind: 'process' }, { id: 'd', label: 'D', kind: 'end' }], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }] }
  const layout = layoutFlow(config)
  const positions = Object.fromEntries(layout.nodes.map((node) => [node.id, node]))
  assert.equal(positions.a.x, 120)
  assert.equal(positions.b.x, positions.c.x)
  assert.equal(positions.d.x, positions.b.x + 220)
  assert.equal(positions.b.y === positions.c.y, false)
  assert.equal(layout.width, 680)
})

test('single-node flow still has a bounded readable canvas', () => {
  const layout = layoutFlow({ version: 1, type: 'flow', nodes: [{ id: 'only', label: '仅一步', kind: 'start' }], edges: [] })
  assert.equal(layout.nodes.length, 1)
  assert.equal(layout.width, 320)
  assert.equal(layout.height, 180)
})

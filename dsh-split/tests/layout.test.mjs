#!/usr/bin/env node
/**
 * Layout tests (W008): the pure state machine behind the workbench.
 *
 * Run: node tests/layout.test.mjs
 */
import { strict as assert } from 'node:assert'
import {
  close,
  cycle,
  deserialize,
  emptyLayout,
  focus,
  focusOf,
  move,
  place,
  reveal,
  serialize,
} from '../dist/layout.mjs'

let passed = 0
const failures = []

function check(name, run) {
  try {
    run()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failures.push(name)
    console.log('  FAIL ' + name + ' — ' + (error.message ?? String(error)))
  }
}

console.log('\nlayout: placing panels')

check('an empty layout has no focus', () => {
  assert.equal(focusOf(emptyLayout()), null)
})

check('the first placement focuses the new panel', () => {
  const { state, id, created } = place(emptyLayout(), 's1')
  assert.equal(created, true)
  assert.equal(focusOf(state), id)
  assert.equal(state.panels.length, 1)
})

check('placing the same session twice focuses instead of duplicating (F12)', () => {
  const first = place(emptyLayout(), 's1')
  const second = place(first.state, 's1')
  assert.equal(second.created, false)
  assert.equal(second.state.panels.length, 1)
  assert.equal(second.id, first.id)
})

check('placing at an index inserts after the reference panel', () => {
  let state = place(emptyLayout(), 's1').state
  state = place(state, 's2').state
  const inserted = place(state, 's3', { at: 1 })
  assert.deepEqual(inserted.state.panels.map((panel) => panel.sessionId), ['s1', 's3', 's2'])
})

check('panel ids stay unique across sessions and placements', () => {
  let state = emptyLayout()
  for (const id of ['s1', 's2', 's3', 's4']) state = place(state, id).state
  const ids = new Set(state.panels.map((panel) => panel.id))
  assert.equal(ids.size, state.panels.length)
})

console.log('\nlayout: focus, cycling, moving')

check('focus only moves to existing panels', () => {
  const state = place(emptyLayout(), 's1').state
  assert.deepEqual(focus(state, 'nope'), state)
})

check('cycling wraps in reading order', () => {
  let state = place(emptyLayout(), 's1').state
  state = place(state, 's2').state
  const first = state.panels[0].id
  const second = state.panels[1].id
  state = focus(state, first)
  assert.equal(focusOf(cycle(state, 1)), second)
  assert.equal(focusOf(cycle(cycle(state, 1), 1)), first)
  assert.equal(focusOf(cycle(state, -1)), second)
  assert.equal(focusOf(cycle(cycle(state, -1), -1)), first)
})

check('moving reorders without losing a panel', () => {
  let state = place(emptyLayout(), 's1').state
  state = place(state, 's2').state
  state = place(state, 's3').state
  const moved = move(state, state.panels[2].id, 0)
  assert.deepEqual(moved.panels.map((panel) => panel.sessionId), ['s3', 's1', 's2'])
  assert.equal(moved.panels.length, 3)
})

check('reveal focuses an existing panel and ignores unknown sessions', () => {
  let state = place(emptyLayout(), 's1').state
  state = place(state, 's2').state
  assert.equal(focusOf(reveal(state, 's1')), state.panels[0].id)
  assert.deepEqual(reveal(state, 'nope'), state)
})

console.log('\nlayout: closing')

check('closing hands focus to the neighbour', () => {
  let state = place(emptyLayout(), 's1').state
  state = place(state, 's2').state
  state = place(state, 's3').state
  const closed = close(state, state.panels[1].id)
  assert.deepEqual(closed.state.panels.map((panel) => panel.sessionId), ['s1', 's3'])
  assert.equal(closed.focus, state.panels[2].id)
})

check('closing the last panel leaves nothing to focus', () => {
  const state = place(emptyLayout(), 's1').state
  const closed = close(state, state.panels[0].id)
  assert.equal(closed.state.panels.length, 0)
  assert.equal(closed.focus, null)
  assert.equal(focusOf(closed.state), null)
})

check('closing an unknown panel changes nothing', () => {
  const state = place(emptyLayout(), 's1').state
  const closed = close(state, 'nope')
  assert.deepEqual(closed.state, state)
})

console.log('\nlayout: persistence')

check('serialize/deserialize round-trips', () => {
  let state = place(emptyLayout(), 's1').state
  state = place(state, 's2').state
  const restored = deserialize(JSON.parse(JSON.stringify(serialize(state))))
  assert.deepEqual(restored.panels.map((panel) => panel.id), state.panels.map((panel) => panel.id))
  assert.equal(focusOf(restored), focusOf(state))
})

check('deserialize drops duplicates, malformed entries and unknown focus', () => {
  const restored = deserialize({
    schemaVersion: 1,
    focusedId: 'ghost',
    panels: [
      { id: 'a', sessionId: 's1' },
      { id: 'a', sessionId: 's2' },
      { id: 'b', sessionId: 's1' },
      { id: 3, sessionId: 's3' },
      'nonsense',
      { id: 'c', sessionId: 's4' },
    ],
  })
  assert.deepEqual(restored.panels.map((panel) => panel.id), ['a', 'c'])
  assert.equal(focusOf(restored), 'a')
})

check('deserialize refuses a future schema version wholesale', () => {
  const restored = deserialize({ schemaVersion: 2, panels: [{ id: 'a', sessionId: 's1' }] })
  assert.equal(restored.panels.length, 0)
})

check('deserialize rejects empty ids', () => {
  const restored = deserialize({
    schemaVersion: 1,
    panels: [
      { id: '', sessionId: 's1' },
      { id: 'b', sessionId: '' },
      { id: 'c', sessionId: 's2' },
    ],
  })
  assert.deepEqual(restored.panels.map((panel) => panel.id), ['c'])
})

check('deserialize tolerates garbage', () => {
  for (const raw of [null, 42, 'text', {}, { panels: 'nope' }, []]) {
    assert.deepEqual(deserialize(raw).panels, [])
  }
})

console.log('')
if (failures.length === 0) {
  console.log('layout: all ' + passed + ' checks passed')
  process.exit(0)
}
console.log('layout: ' + failures.length + ' of ' + (passed + failures.length) + ' checks failed')
for (const name of failures) console.log('  - ' + name)
process.exit(2)

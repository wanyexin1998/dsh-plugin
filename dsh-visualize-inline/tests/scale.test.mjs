import test from 'node:test'
import assert from 'node:assert/strict'
import { createScale, formatValue, shortLabel } from '../lib/scale.js'

test('bar scale always includes a correct zero baseline', () => {
  assert.equal(createScale([730, 950, 680], true).min <= 0, true)
  assert.equal(createScale([-10, -5], true).max >= 0, true)
  const mixed = createScale([-10, 20], true)
  assert.equal(mixed.map(0, 200, 0) > 0, true)
  assert.equal(mixed.map(0, 200, 0) < 200, true)
  assert.equal(createScale([0, 0], true).min, 0)
})

test('line scale covers equal and negative values without forced zero or clipping', () => {
  const equal = createScale([5, 5], false)
  assert.ok(equal.min < 5 && equal.max > 5)
  const negative = createScale([-20, -10], false)
  assert.ok(equal.max > 0)
  assert.ok(negative.max <= 0)
  for (const value of [-20, -10]) {
    const y = negative.map(value, 200, 0)
    assert.ok(y >= 0 && y <= 200)
  }
})

test('empty numeric values still produce a finite drawable scale', () => {
  const scale = createScale([], false)
  assert.ok(Number.isFinite(scale.min) && Number.isFinite(scale.max))
  assert.ok(scale.ticks.length > 1)
})

test('raw data values keep exact string forms and null stays explicit', () => {
  assert.equal(formatValue('001.2300', '万元'), '001.2300 万元')
  assert.equal(formatValue(null, '万元'), '无数据')
  assert.equal(shortLabel('一二三四五六七八九十甲乙丙'), '一二三四五六七八九十甲…')
})

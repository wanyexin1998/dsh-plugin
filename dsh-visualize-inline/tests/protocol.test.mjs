import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_DATA_POINTS, MAX_JSON_BYTES, parseVisualize } from '../lib/protocol.js'

const metric = (extra = {}) => JSON.stringify({ version: 1, type: 'metric', label: '现金流', value: 2450, unit: '万元', ...extra })
const progress = (extra = {}) => JSON.stringify({ version: 1, type: 'progress', label: '目标', value: 80, target: 100, ...extra })
const chart = (data = [{ label: 'A', value: 1 }], extra = {}) => JSON.stringify({ version: 1, type: 'chart', chart: 'bar', data, ...extra })
const valid = (code) => {
  const result = parseVisualize(code)
  assert.equal(result.ok, true, result.ok ? '' : result.reason)
  return result.config
}
const invalid = (code) => assert.equal(parseVisualize(code).ok, false, code.slice(0, 160))

test('accepts metric numbers and exact numeric strings without calculating them', () => {
  assert.equal(valid(metric()).value, 2450)
  invalid(metric({ value: '001.2300' }))
  assert.equal(valid(metric({ value: '123456789012345678901234567890.123400' })).value, '123456789012345678901234567890.123400')
  assert.equal(valid(metric({ value: '-1.20e+3' })).value, '-1.20e+3')
})

test('accepts Unicode, escapes and all chart kinds while preserving input order', () => {
  assert.equal(valid('{"version":1,"type":"metric","label":"累计\\u73b0金流 💰","value":1}').label, '累计现金流 💰')
  const data = [{ label: '11月', value: -680 }, { label: '9月', value: null }, { label: '10月', value: 950 }]
  for (const kind of ['bar', 'horizontal-bar', 'line']) {
    const config = valid(chart(data, { chart: kind }))
    assert.deepEqual(config.data, data)
  }
})

test('accepts over-target progress and computes no replacement values in the parser', () => {
  const config = valid(progress({ value: 2450, target: 3000, unit: '万元' }))
  assert.equal(config.value, 2450)
  assert.equal(config.target, 3000)
  assert.equal(valid(progress({ value: 125, target: 100 })).value, 125)
  assert.equal(valid(progress({ value: 0, target: 100 })).value, 0)
})

test('accepts exactly 120 points and rejects 121 without truncating', () => {
  const data = Array.from({ length: MAX_DATA_POINTS }, (_, index) => ({ label: `L${index}`, value: index }))
  assert.equal(valid(chart(data)).data.length, 120)
  invalid(chart([...data, { label: 'overflow', value: 120 }]))
})

test('rejects malformed JSON, trailing content, comments and trailing commas', () => {
  for (const code of ['', '{', '[]', 'null', '{}', `${metric()} trailing`, `//x\n${metric()}`, '{"version":1,}', '{"version":1 "type":"metric"}']) invalid(code)
})

test('rejects unknown versions, types, fields and nested fields', () => {
  invalid(metric({ version: 2 }))
  invalid(metric({ type: 'unknown' }))
  invalid(metric({ extra: true }))
  invalid(chart([{ label: 'A', value: 1, series: 'actual' }]))
  invalid(chart([{ label: 'A', value: 1 }], { html: '<img src=x>' }))
  invalid(progress({ note: 'not in V1' }))
})

test('rejects missing fields, empty labels, duplicate labels and unsupported chart kinds', () => {
  invalid(JSON.stringify({ version: 1, type: 'metric', value: 1 }))
  invalid(metric({ label: '   ' }))
  invalid(chart([]))
  invalid(chart([{ label: 'A', value: 1 }, { label: 'A', value: 2 }]))
  invalid(chart([{ label: 'A' }]))
  invalid(chart([{ value: 1 }]))
  invalid(chart([{ label: 'A', value: 1 }], { chart: 'pie' }))
})

test('detects duplicate JSON keys at every level', () => {
  invalid('{"version":1,"version":1,"type":"metric","label":"A","value":1}')
  invalid('{"version":1,"type":"chart","chart":"bar","data":[{"label":"A","label":"B","value":1}]}')
})

test('rejects prototype-pollution keys without modifying object prototypes', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    invalid(`{"version":1,"type":"metric","label":"A","value":1,"${key}":{}}`)
  }
  assert.equal({}.polluted, undefined)
})

test('rejects non-finite and unsafe numeric values in every numeric position', () => {
  invalid(metric({ value: 1e309 }))
  invalid(metric({ value: 9007199254740992 }))
  invalid(progress({ target: 0 }))
  invalid(progress({ target: -1 }))
  invalid(progress({ value: -1 }))
  invalid(chart([{ label: 'A', value: 9007199254740992 }]))
  invalid('{"version":1,"type":"chart","chart":"bar","data":[{"label":"A","value":1e309}]}')
  invalid('{"version":1,"type":"metric","label":"A","value":01}')
})

test('rejects invalid metric strings, nulls, booleans and non-string units', () => {
  for (const value of ['', ' ', '01', '+1', '1,000', 'NaN', 'Infinity', '0x10', '1e', '1'.repeat(65)]) invalid(metric({ value }))
  for (const value of [null, true, {}, []]) invalid(metric({ value }))
  invalid(metric({ unit: 1 }))
})

test('enforces Unicode-aware text limits', () => {
  assert.equal(valid(metric({ label: '💰'.repeat(100) })).label.length, 200)
  invalid(metric({ label: '💰'.repeat(101) }))
  invalid(metric({ unit: 'u'.repeat(31) }))
  invalid(metric({ note: 'n'.repeat(301) }))
  invalid(chart([{ label: 'A', value: 1 }], { title: 't'.repeat(121) }))
})

test('enforces UTF-8 byte limit before schema validation', () => {
  assert.equal(MAX_JSON_BYTES, 32768)
  invalid(metric({ note: '汉'.repeat(12000) }))
  invalid('💰'.repeat(9000))
})

test('rejects invalid Unicode and excessive nesting', () => {
  invalid('{"version":1,"type":"metric","label":"\\ud800","value":1}')
  invalid('{"version":1,"type":"metric","label":"A","value":1,"extra":[[[[[[[[[[1]]]]]]]]]]}')
})

test('allows explicit null chart values but rejects undefined-like substitutes', () => {
  assert.equal(valid(chart([{ label: 'A', value: null }])).data[0].value, null)
  for (const value of ['null', undefined, false, {}, []]) invalid(chart([{ label: 'A', value }]))
})

test('treats URL and HTML strings only as text; active content fields remain invalid', () => {
  const label = '<img src=x onerror=alert(1)> https://example.com'
  assert.equal(valid(metric({ label })).label, label)
  invalid(metric({ value: '<script>alert(1)</script>' }))
})

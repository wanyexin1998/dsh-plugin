import { describe, expect, it } from 'vitest'

import { columnKind, formatCell, formatNumber, fullValue } from '../src/client/format.ts'

describe('column classification', () => {
  it('maps the wire type names Doris and MySQL actually return', () => {
    expect(columnKind('LONG')).toBe('number')
    expect(columnKind('NEWDECIMAL')).toBe('number')
    expect(columnKind('DATETIME')).toBe('date')
    expect(columnKind('TIME')).toBe('time')
    expect(columnKind('VAR_STRING')).toBe('text')
    expect(columnKind('LONGLONG')).toBe('number')
    expect(columnKind('JSON')).toBe('json')
    expect(columnKind('BLOB')).toBe('binary')
    expect(columnKind('GEOMETRY')).toBe('binary')
  })

  it('is case-insensitive and degrades unknown names to unknown', () => {
    expect(columnKind('long')).toBe('number')
    expect(columnKind('UNKNOWN')).toBe('unknown')
    expect(columnKind('SOMETHING_NEW')).toBe('unknown')
  })
})

describe('cell formatting', () => {
  it('renders NULL as the weak placeholder, right-aligned for numbers', () => {
    expect(formatCell(null, 'number')).toEqual({ text: 'NULL', align: 'right', isNull: true })
    expect(formatCell(undefined, 'text')).toEqual({ text: 'NULL', align: 'left', isNull: true })
  })

  it('groups digits without touching the fraction', () => {
    expect(formatCell(103572, 'number')).toEqual({ text: '103,572', align: 'right', isNull: false })
    expect(formatCell('-1299.5', 'number')).toEqual({ text: '-1,299.5', align: 'right', isNull: false })
    expect(formatCell('1234', 'number')).toEqual({ text: '1,234', align: 'right', isNull: false })
  })

  it('leaves a non-numeric value under a numeric column alone', () => {
    expect(formatCell('n/a', 'number')).toEqual({ text: 'n/a', align: 'right', isNull: false })
  })

  it('renders dates as ISO-ish text and passes strings through', () => {
    expect(formatCell(new Date('2026-10-17T08:12:33.000Z'), 'date')).toEqual({
      text: '2026-10-17 08:12:33',
      align: 'left',
      isNull: false,
    })
    expect(formatCell('2026-10-17', 'date')).toEqual({ text: '2026-10-17', align: 'left', isNull: false })
  })

  it('summarises binary payloads by size', () => {
    expect(formatCell(new Uint8Array(3), 'binary')).toEqual({ text: '<binary 3 B>', align: 'left', isNull: false })
    expect(formatCell('abc', 'binary')).toEqual({ text: '<binary 3 B>', align: 'left', isNull: false })
  })

  it('keeps JSON as text when the driver already gives a string', () => {
    expect(formatCell('{"a":1}', 'json')).toEqual({ text: '{"a":1}', align: 'left', isNull: false })
    expect(formatCell({ a: 1 }, 'json')).toEqual({ text: '{"a":1}', align: 'left', isNull: false })
  })

  it('falls back to String() for text, time and unknown columns', () => {
    expect(formatCell('SO20261001', 'text')).toEqual({ text: 'SO20261001', align: 'left', isNull: false })
    expect(formatCell('08:12:33', 'time')).toEqual({ text: '08:12:33', align: 'left', isNull: false })
    expect(formatCell(true, 'unknown')).toEqual({ text: 'true', align: 'left', isNull: false })
  })
})

describe('formatNumber (status bar)', () => {
  it('groups thousands and keeps up to four decimals', () => {
    expect(formatNumber(3500.5)).toBe('3,500.5')
    expect(formatNumber(1234567)).toBe('1,234,567')
    expect(formatNumber(0.123456)).toBe('0.1235')
  })

  it('folds negative zero and rounds cleanly', () => {
    expect(formatNumber(-0)).toBe('0')
    expect(formatNumber(-1e-13)).toBe('0')
    expect(formatNumber(2.00004)).toBe('2')
  })

  it('passes non-finite values through as text', () => {
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('Infinity')
  })
})

describe('fullValue (value viewer)', () => {
  it('renders NULL without pretending it is text', () => {
    expect(fullValue(null, 'text')).toEqual({ text: 'NULL', chars: 0, kind: 'text' })
    expect(fullValue(undefined, 'unknown').text).toBe('NULL')
  })

  it('returns long text whole, and counts characters', () => {
    const long = 'a'.repeat(5000)
    const view = fullValue(long, 'text')
    expect(view.text).toHaveLength(5000)
    expect(view.chars).toBe(5000)
  })

  it('pretty-prints JSON that parses and leaves it alone when it does not', () => {
    const pretty = fullValue('{"a":1}', 'json')
    expect(pretty.text).toContain('"a": 1')

    const broken = fullValue('{oops', 'json')
    expect(broken.text).toBe('{oops')
  })

  it('stringifies a JSON object that arrived already parsed', () => {
    expect(fullValue({ a: 1 }, 'json').text).toContain('"a": 1')
  })

  it('shows the first bytes of a blob plus its size', () => {
    const bytes = new Uint8Array(100).fill(255)
    const view = fullValue(bytes, 'binary')

    expect(view.text).toContain('ff ff ff')
    expect(view.text).toContain('<binary 100 B>')
    expect(view.text).toContain('…')
  })

  it('does not add an ellipsis to a short blob', () => {
    expect(fullValue(new Uint8Array([1, 2]), 'binary').text).not.toContain('…')
  })

  it('renders dates as ISO and numbers as text', () => {
    expect(fullValue(new Date('2026-10-19T00:00:00Z'), 'date').text).toBe('2026-10-19T00:00:00.000Z')
    expect(fullValue(42, 'number').text).toBe('42')
  })
})

import { describe, expect, it } from 'vitest'

import { columnName, crc32, toXlsx, xmlEscape, zip } from '../src/client/xlsx.ts'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
/** Entries are stored, so their XML is readable in the raw archive. */
const raw = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes)

describe('crc32', () => {
  it('matches the known CRC for "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xCBF43926)
  })

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array())).toBe(0)
  })
})

describe('xmlEscape', () => {
  it('escapes the five XML entities', () => {
    expect(xmlEscape('a&b<c>d"e')).toBe('a&amp;b&lt;c&gt;d&quot;e')
  })
})

describe('columnName', () => {
  it('maps indexes to Excel labels', () => {
    expect(columnName(0)).toBe('A')
    expect(columnName(25)).toBe('Z')
    expect(columnName(26)).toBe('AA')
    expect(columnName(701)).toBe('ZZ')
    expect(columnName(702)).toBe('AAA')
  })
})

describe('zip', () => {
  it('writes a stored archive with a local header, directory and EOCD', () => {
    const bytes = zip([{ name: 'a.txt', bytes: new TextEncoder().encode('hello') }])

    expect(bytes[0]).toBe(0x50) // 'P'
    expect(bytes[1]).toBe(0x4B) // 'K'
    const text = raw(bytes)
    expect(text).toContain('a.txt')
    expect(text).toContain('hello')
    // End of central directory record at the tail.
    expect(bytes.slice(-22, -18)).toEqual(new Uint8Array([0x50, 0x4B, 0x05, 0x06]))
  })
})

describe('toXlsx', () => {
  const workbook = toXlsx({
    name: '结果',
    columns: ['id', 'name', 'amount'],
    rows: [['1', 'Alice', '12.5'], ['2', 'a<b', '']],
  })

  it('looks like a zip archive', () => {
    expect(workbook[0]).toBe(0x50)
    expect(workbook[1]).toBe(0x4B)
  })

  it('contains the five required parts', () => {
    const text = raw(workbook)
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) {
      expect(text).toContain(part)
    }
  })

  it('writes numbers as numbers and text inline', () => {
    const sheet = decode(workbook).slice(decode(workbook).indexOf('<sheetData>'))
    expect(sheet).toContain('<v>1</v>')
    expect(sheet).toContain('<v>12.5</v>')
    expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">Alice')
  })

  it('escapes text and skips empty cells', () => {
    const sheet = decode(workbook)
    expect(sheet).toContain('a&lt;b')
    expect(sheet).not.toContain('<c r="C3"')
  })

  it('keeps non-ASCII sheet names', () => {
    expect(decode(workbook)).toContain('name="结果"')
  })

  it('replaces characters Excel forbids in sheet names', () => {
    const bytes = toXlsx({ name: 'a/b:c*?', columns: ['x'], rows: [] })
    expect(decode(bytes)).toContain('name="a b c  "')
  })

  it('falls back to Sheet1 for an empty name', () => {
    const bytes = toXlsx({ name: '', columns: ['x'], rows: [] })
    expect(decode(bytes)).toContain('name="Sheet1"')
  })
})

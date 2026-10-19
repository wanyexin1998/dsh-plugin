/**
 * Minimal XLSX writer.
 *
 * The panel needs "导出 Excel", and pulling a spreadsheet library into a bundle
 * that runs inside the host costs more than the feature is worth. XLSX is a zip
 * of five small XML parts, and *stored* (uncompressed) entries need no deflate —
 * only a CRC32 — so the whole thing fits in one dependency-free module.
 *
 * Scope: one sheet, inline strings, numbers where they parse, no styles. That
 * covers "open the result in Excel" without pretending to be a report writer.
 */

/** Cells are already-formatted strings; the writer decides what is numeric. */
export interface XlsxSheet {
  readonly name: string
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** CRC32 of a byte array, as the zip format wants it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xFF]! ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/** XML-escape one value. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const encoder = new TextEncoder()

interface ZipEntry {
  readonly name: string
  readonly bytes: Uint8Array
  readonly crc: number
}

/** One stored (uncompressed) zip entry's local header plus payload. */
function localHeader(entry: ZipEntry): Uint8Array {
  const name = encoder.encode(entry.name)
  const buffer = new Uint8Array(30 + name.length + entry.bytes.length)
  const view = new DataView(buffer.buffer)
  view.setUint32(0, 0x04034B50, true)
  view.setUint16(4, 20, true) // version needed
  view.setUint16(6, 0, true) // flags
  view.setUint16(8, 0, true) // method: stored
  view.setUint16(10, 0, true) // time
  view.setUint16(12, 0, true) // date
  view.setUint32(14, entry.crc, true)
  view.setUint32(18, entry.bytes.length, true)
  view.setUint32(22, entry.bytes.length, true)
  view.setUint16(26, name.length, true)
  view.setUint16(28, 0, true)
  buffer.set(name, 30)
  buffer.set(entry.bytes, 30 + name.length)
  return buffer
}

/** One central directory record for a stored entry. */
function centralRecord(entry: ZipEntry, offset: number): Uint8Array {
  const name = encoder.encode(entry.name)
  const buffer = new Uint8Array(46 + name.length)
  const view = new DataView(buffer.buffer)
  view.setUint32(0, 0x02014B50, true)
  view.setUint16(4, 20, true) // version made by
  view.setUint16(6, 20, true) // version needed
  view.setUint16(8, 0, true)
  view.setUint16(10, 0, true) // method: stored
  view.setUint16(12, 0, true)
  view.setUint16(14, 0, true)
  view.setUint32(16, entry.crc, true)
  view.setUint32(20, entry.bytes.length, true)
  view.setUint32(24, entry.bytes.length, true)
  view.setUint16(28, name.length, true)
  view.setUint16(30, 0, true) // extra
  view.setUint16(32, 0, true) // comment
  view.setUint16(34, 0, true) // disk
  view.setUint16(36, 0, true) // internal attrs
  view.setUint32(38, 0, true) // external attrs
  view.setUint32(42, offset, true)
  buffer.set(name, 46)
  return buffer
}

/** Zip a set of named byte blobs (stored entries). */
export function zip(entries: readonly { readonly name: string; readonly bytes: Uint8Array }[]): Uint8Array {
  const prepared: ZipEntry[] = entries.map(entry => ({ ...entry, crc: crc32(entry.bytes) }))
  const locals: Uint8Array[] = []
  const records: Uint8Array[] = []
  let offset = 0
  for (const entry of prepared) {
    const local = localHeader(entry)
    locals.push(local)
    records.push(centralRecord(entry, offset))
    offset += local.length
  }
  const directory = records.reduce((total, record) => total + record.length, 0)
  const end = new Uint8Array(22)
  const view = new DataView(end.buffer)
  view.setUint32(0, 0x06054B50, true)
  view.setUint16(8, prepared.length, true)
  view.setUint16(10, prepared.length, true)
  view.setUint32(12, directory, true)
  view.setUint32(16, offset, true)

  const total = offset + directory + end.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const local of locals) { out.set(local, cursor); cursor += local.length }
  for (const record of records) { out.set(record, cursor); cursor += record.length }
  out.set(end, cursor)
  return out
}

/** Numeric-looking cell text becomes a number so Excel can sum it. */
function isNumeric(text: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(text)
}

function cell(value: string, columnIndex: number, rowIndex: number): string {
  const ref = `${columnName(columnIndex)}${rowIndex}`
  if (isNumeric(value)) return `<c r="${ref}"><v>${value}</v></c>`
  if (value === '') return ''
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
}

/** Excel column label for a zero-based index (0 → A, 26 → AA). */
export function columnName(index: number): string {
  let name = ''
  let value = index
  while (value >= 0) {
    name = String.fromCharCode((value % 26) + 65) + name
    value = Math.floor(value / 26) - 1
  }
  return name
}

function sheetXml(sheet: XlsxSheet): string {
  const header = `<row r="1">${sheet.columns.map((name, index) => cell(name, index, 1)).join('')}</row>`
  const body = sheet.rows.map((row, rowIndex) => {
    const r = rowIndex + 2
    const cells = row.map((value, index) => cell(value, index, r)).join('')
    return `<row r="${r}">${cells}</row>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${header}${body}</sheetData></worksheet>`
}

/** Build a one-sheet workbook. */
export function toXlsx(sheet: XlsxSheet): Uint8Array {
  const safeName = sheet.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1'
  const entries = [
    {
      name: '[Content_Types].xml',
      bytes: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    },
    {
      name: '_rels/.rels',
      bytes: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      name: 'xl/workbook.xml',
      bytes: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      bytes: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    },
    { name: 'xl/worksheets/sheet1.xml', bytes: encoder.encode(sheetXml(sheet)) },
  ]
  return zip(entries)
}

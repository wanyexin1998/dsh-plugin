// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView, activateHover } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import type { SchemaIndex } from '../src/client/completion.ts'
import { buildExtrasExtension, symbolInfoAt, tooltipDom } from '../src/client/sql-extras.ts'

const schema: SchemaIndex = {
  tables: [
    {
      schema: 'dwd',
      kind: 'table',
      name: 'dwd_order',
      columns: [
        { name: 'order_id', type: 'BIGINT' },
        { name: 'amount', type: 'DECIMAL' },
        { name: 'dt', type: 'DATE' },
      ],
    },
    {
      schema: 'ads',
      kind: 'view',
      name: 'v_daily',
      columns: [{ name: 'day', type: 'DATE' }, { name: 'amount', type: 'DECIMAL' }],
    },
    {
      schema: 'dwd',
      kind: 'table',
      name: 'wide',
      columns: Array.from({ length: 8 }, (_, index) => ({ name: `c${String(index)}`, type: 'INT' })),
    },
    { name: 'loose', columns: [{ name: 'id', type: 'INT' }] },
  ],
}

/** Caret/pointer at `marker`, then resolve the hover card there. */
function infoAt(sql: string, marker: string): ReturnType<typeof symbolInfoAt> {
  return symbolInfoAt(sql, sql.indexOf(marker) + 1, schema)
}

describe('symbolInfoAt: tables', () => {
  it('describes a table with its database and column preview', () => {
    const info = infoAt('SELECT * FROM dwd_order', 'dwd_order')
    expect(info).toMatchObject({ kind: '表', title: 'dwd_order', from: 14, to: 23 })
    expect(info?.lines[0]).toBe('数据库：dwd')
    expect(info?.lines[1]).toBe('类型：表')
    expect(info?.lines[2]).toBe('列：3 个')
    expect(info?.lines).toContain('amount  DECIMAL')
  })

  it('describes a view, a table without a database, and a wide table', () => {
    expect(infoAt('SELECT * FROM v_daily', 'v_daily')?.kind).toBe('视图')
    expect(infoAt('SELECT * FROM loose', 'loose')?.lines[0]).toBe('数据库：（连接默认库）')
    const wide = infoAt('SELECT * FROM dwd.wide', 'wide')
    expect(wide?.lines[2]).toBe('列：8 个')
    expect(wide?.lines[wide.lines.length - 1]).toBe('…')
  })

  it('resolves a schema-qualified table name', () => {
    expect(infoAt('SELECT * FROM dwd.dwd_order', 'dwd_order')).toMatchObject({ kind: '表', title: 'dwd_order' })
  })
})

describe('symbolInfoAt: columns and functions', () => {
  it('describes a column that only one statement table has', () => {
    expect(infoAt('SELECT * FROM dwd_order WHERE dt = 1', 'dt')).toMatchObject({
      kind: '列',
      title: 'dt',
      lines: ['类型：DATE', '表：dwd.dwd_order'],
    })
  })

  it('describes alias.column and schema.table.column references', () => {
    expect(infoAt('SELECT o.amount FROM dwd_order o', 'amount')).toMatchObject({ kind: '列', title: 'amount' })
    expect(infoAt('SELECT dwd.dwd_order.amount FROM dwd.dwd_order', 'amount')).toMatchObject({
      kind: '列',
      title: 'amount',
      lines: ['类型：DECIMAL', '表：dwd.dwd_order'],
    })
    // A table outside any database, referenced through its own name.
    const loose = infoAt('SELECT loose.id FROM loose', 'id')
    expect(loose).toMatchObject({ kind: '列', title: 'id', lines: ['类型：INT', '表：loose'] })
    // A derived table in the statement does not stop the real ones resolving.
    expect(infoAt('SELECT * FROM (SELECT 1) x JOIN dwd_order o ON dt = 1', 'dt')).toMatchObject({ kind: '列' })
    // An unknown schema in a three-part chain yields nothing.
    expect(infoAt('SELECT nope.t.col FROM dwd_order', 'col')).toBeNull()
  })

  it('describes a function only when it is actually called', () => {
    const info = infoAt('SELECT DATE_FORMAT(dt, 1) FROM dwd_order', 'DATE_FORMAT')
    expect(info).toMatchObject({ kind: '函数', title: 'DATE_FORMAT' })
    expect(info?.lines[0]).toBe('签名：DATE_FORMAT(date, format)')
    expect(info?.lines).toContain('类别：日期')
    // Not called: `NOW` is just an unknown name here.
    expect(infoAt('SELECT NOW FROM dwd_order', 'NOW')).toBeNull()
    // Called but not in the catalogue: neither a column nor a table.
    expect(infoAt('SELECT zzz(1) FROM dwd_order', 'zzz')).toBeNull()
  })

  it('stays quiet when the answer would be a guess', () => {
    // Both tables in the statement have an `amount` column.
    expect(infoAt('SELECT * FROM dwd_order o JOIN v_daily v ON amount = 1', 'amount')).toBeNull()
    expect(infoAt('SELECT * FROM dwd_order WHERE nope = 1', 'nope')).toBeNull()
    expect(infoAt('SELECT * FROM dwd_order o WHERE o.nope = 1', 'nope')).toBeNull()
    expect(infoAt('SELECT dwd.dwd_order.nope FROM dwd.dwd_order', 'nope')).toBeNull()
    expect(infoAt('SELECT nope.nope FROM dwd_order', 'nope')).toBeNull()
    expect(infoAt('SELECT amount', 'amount')).toBeNull()
    // Four parts is not a name shape this module resolves.
    expect(infoAt('SELECT a.b.c.d FROM dwd_order', 'd')).toBeNull()
    // Not on an identifier at all.
    expect(infoAt('SELECT a . b FROM dwd_order', '.')).toBeNull()
    expect(symbolInfoAt(' SELECT', 0, schema)).toBeNull()
    expect(symbolInfoAt('SELECT * FROM dwd_order', 14, undefined)).toBeNull()
  })
})

describe('tooltipDom', () => {
  it('renders the heading and one row per line', () => {
    const dom = tooltipDom({ from: 0, to: 4, kind: '表', title: 'dwd_order', lines: ['数据库：dwd', '列：3 个'] })
    expect(dom.className).toBe('cm-sql-hover')
    expect(dom.querySelector('.cm-sql-hover-head')?.textContent).toBe('表 dwd_order')
    expect([...dom.querySelectorAll('.cm-sql-hover-line')].map(row => row.textContent))
      .toEqual(['数据库：dwd', '列：3 个'])
  })
})

describe('buildExtrasExtension', () => {
  let view: EditorView | undefined

  afterEach(() => {
    view?.destroy()
    view = undefined
    document.body.innerHTML = ''
  })

  function mount(doc: string, options: Parameters<typeof buildExtrasExtension>[0] = { schema }): EditorView {
    view = new EditorView({
      state: EditorState.create({ doc, extensions: [buildExtrasExtension(options)] }),
      parent: document.body,
    })
    return view
  }

  it('registers both completion sources next to the existing ones', () => {
    const instance = mount('SELECT ')
    const sources = instance.state.languageDataAt<{ autocomplete: unknown }>('autocomplete', 'SELECT '.length)
    expect(sources).toHaveLength(2)
    // The sources must keep their identity: CodeMirror tracks an active source by
    // function reference, so a provider that rebuilt them would never show results.
    const again = instance.state.languageDataAt('autocomplete', 3)
    expect(again[0]).toBe(sources[0])
    expect(again[1]).toBe(sources[1])
  })

  it('paints lint errors by default', () => {
    const instance = mount('SELECT * FROM nope')
    expect(instance.dom.querySelector('.cm-sql-diag-error')).not.toBeNull()
  })

  it('shows a hover card for a table after a short delay', async () => {
    const doc = 'SELECT * FROM dwd_order'
    const instance = mount(doc, { schema, hoverTime: 0 })
    activateHover(instance, doc.indexOf('dwd_order') + 1, 1)
    await new Promise(resolve => setTimeout(resolve, 120))
    const tooltip = document.querySelector('.cm-tooltip')
    expect(tooltip?.textContent).toContain('表 dwd_order')
    expect(tooltip?.textContent).toContain('数据库：dwd')
  })

  it('shows no hover card when the name is unknown', async () => {
    const doc = 'SELECT zzz FROM dwd_order'
    const instance = mount(doc, { schema, hoverTime: 0 })
    activateHover(instance, doc.indexOf('zzz') + 1, 1)
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(document.querySelector('.cm-tooltip')).toBeNull()
  })

  it('honours the lint/hover switches and knownTablesOnly', () => {
    const lintOff = mount('SELECT * FROM nope', { schema, lint: false })
    expect(lintOff.dom.querySelector('.cm-sql-diag-error')).toBeNull()
    view?.destroy()

    const quiet = mount('SELECT * FROM nope', { schema, knownTablesOnly: true })
    expect(quiet.dom.querySelector('.cm-sql-diag-error')).toBeNull()
    view?.destroy()

    mount('SELECT * FROM dwd_order', { schema, hover: false })
    // No hover extension means no tooltip state at all; the editor still mounts.
    expect(view?.dom.classList.contains('cm-editor')).toBe(true)
  })

  it('builds without a schema, and with no options at all', async () => {
    const instance = mount('SELECT * FROM nope', {})
    expect(instance.dom.querySelector('.cm-sql-diag-error')).toBeNull()
    activateHover(instance, 15, 1)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(document.querySelector('.cm-tooltip')).toBeNull()

    expect(buildExtrasExtension()).toBeDefined()
  })
})

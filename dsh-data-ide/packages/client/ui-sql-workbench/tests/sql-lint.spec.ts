// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import type { SchemaIndex } from '../src/client/completion.ts'
import {
  MAX_DIAGNOSTICS,
  computeDiagnostics,
  sqlLintExtension,
} from '../src/client/sql-lint.ts'

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
    { schema: 'ads', kind: 'view', name: 'v_daily', columns: [{ name: 'day', type: 'DATE' }] },
    // Doris does not report view columns through information_schema; the SHOW
    // fallback may therefore know the object but not its columns.
    { schema: 'ads', kind: 'view', name: 'v_empty', columns: [] },
    { name: 'loose', columns: [{ name: 'id', type: 'INT' }] },
    { schema: 'db1', name: 'dup', columns: [{ name: 'a', type: 'INT' }] },
    { schema: 'db2', name: 'dup', columns: [{ name: 'b', type: 'INT' }] },
  ],
}

/** Diagnostics of one document, with the shared snapshot. */
function diags(sql: string, options?: { knownTablesOnly?: boolean }) {
  return computeDiagnostics(sql, schema, options)
}

describe('computeDiagnostics: syntax', () => {
  it('reports a Lezer parse error at the offending character', () => {
    expect(diags('SELECT a., FROM dwd_order')).toEqual([
      { from: 9, to: 10, severity: 'error', message: '语法错误：此处无法被解析' },
    ])
  })

  it('deduplicates several missing-token errors at the same gap', () => {
    expect(diags('SELECT ((((')).toEqual([
      { from: 10, to: 11, severity: 'error', message: '语法错误：此处无法被解析' },
    ])
  })

  it('reports nothing for empty SQL or clean SQL', () => {
    expect(diags('')).toEqual([])
    expect(diags('   ')).toEqual([])
    expect(diags('SELECT * FROM dwd_order')).toEqual([])
    // A statement with no words at all cannot be a risky write.
    expect(diags(')')).toEqual([{ from: 0, to: 1, severity: 'error', message: '语法错误：此处无法被解析' }])
  })
})

describe('computeDiagnostics: tables and columns', () => {
  it('flags a table the snapshot does not know', () => {
    expect(diags('SELECT * FROM nope')).toEqual([
      { from: 14, to: 18, severity: 'error', message: '未找到表：nope' },
    ])
    // A database prefix does not rescue a table that lives in no database.
    expect(diags('SELECT * FROM db.loose')).toEqual([
      { from: 14, to: 22, severity: 'error', message: '未找到表：db.loose' },
    ])
  })

  it('accepts qualified and alias references to known tables', () => {
    expect(diags('SELECT o.order_id FROM dwd.dwd_order o')).toEqual([])
    expect(diags('SELECT dwd.dwd_order.amount FROM dwd.dwd_order')).toEqual([])
    expect(diags('SELECT dwd_order.amount FROM dwd.dwd_order')).toEqual([])
  })

  it('flags an unknown column of a resolved alias', () => {
    expect(diags('SELECT o.nope FROM dwd.dwd_order o')).toEqual([
      { from: 7, to: 13, severity: 'error', message: '列不存在：o.nope' },
    ])
    expect(diags('SELECT db1.dup.nope FROM db1.dup')).toEqual([
      { from: 7, to: 19, severity: 'error', message: '列不存在：db1.dup.nope' },
    ])
  })

  it('does not guess about views whose columns are unknown', () => {
    expect(diags('SELECT v.missing FROM ads.v_empty v')).toEqual([])
    expect(diags('SELECT v.day FROM ads.v_daily v')).toEqual([])
  })

  it('does not report a table that exists in two databases as missing', () => {
    expect(diags('SELECT * FROM dup')).toEqual([])
    expect(diags('SELECT dup.a FROM db1.dup')).toEqual([])
    // Within the statement the bare name is ambiguous, so column checks skip it.
    expect(diags('SELECT dup.a FROM dup')).toEqual([])
  })

  it('does not report CTEs, derived tables or system catalogs', () => {
    expect(diags('WITH c AS (SELECT 1 AS x) SELECT c.x FROM c')).toEqual([])
    expect(diags('WITH /* note */ c AS (SELECT 1) SELECT * FROM c')).toEqual([])
    expect(diags('WITH `c` AS (SELECT 1) SELECT * FROM `c`')).toEqual([])
    expect(diags('SELECT x.a FROM (SELECT 1 AS a) x')).toEqual([])
    expect(diags('SELECT * FROM information_schema.tables')).toEqual([])
    expect(diags('SELECT * FROM mysql.user')).toEqual([])
  })

  it('skips names it cannot resolve and function calls', () => {
    expect(diags('SELECT foo.bar FROM dwd_order')).toEqual([])
    // A path segment that is not an identifier leaves the chain two-part.
    expect(diags('SELECT o.nope.1 FROM dwd_order o')).toHaveLength(1)
    expect(diags('SELECT db.fn(1) FROM dwd_order')).toEqual([])
    // A keyword alias after UPDATE … ON DUPLICATE KEY is not a table reference.
    expect(diags('INSERT INTO dwd_order VALUES (1) ON DUPLICATE KEY UPDATE amount = 1')).toEqual([])
    // FROM inside EXTRACT() is not a table reference.
    expect(diags('SELECT EXTRACT(YEAR FROM dt) FROM dwd_order')).toEqual([])
  })

  it('checks each statement of a script separately', () => {
    expect(diags('SELECT * FROM nope; SELECT * FROM dwd_order')).toEqual([
      { from: 14, to: 18, severity: 'error', message: '未找到表：nope' },
    ])
    expect(diags('-- just a note\n;')).toEqual([])
  })

  it('suppresses unknown tables when only known objects should be checked', () => {
    expect(diags('SELECT * FROM nope', { knownTablesOnly: true })).toEqual([])
    // Column checks on a resolved table still apply.
    expect(diags('SELECT o.nope FROM dwd_order o', { knownTablesOnly: true })).toHaveLength(1)
  })

  it('checks columns even without a snapshot, but not names', () => {
    expect(computeDiagnostics('SELECT * FROM nope', undefined)).toEqual([])
    expect(computeDiagnostics('UPDATE dwd_order SET amount = 1', undefined)).toHaveLength(1)
  })

  it('caps the number of diagnostics', () => {
    const tables = Array.from({ length: MAX_DIAGNOSTICS + 10 }, (_, index) => `missing_${String(index)}`)
    const sql = `SELECT * FROM ${tables.join(', ')}`
    expect(diags(sql)).toHaveLength(MAX_DIAGNOSTICS)
  })
})

describe('computeDiagnostics: risky writes', () => {
  it('warns about UPDATE and DELETE without a WHERE', () => {
    expect(diags('UPDATE dwd_order SET amount = 1')).toEqual([
      { from: 0, to: 31, severity: 'warning', message: 'UPDATE 没有 WHERE 条件，会作用于整张表' },
    ])
    expect(diags('DELETE FROM dwd_order')).toEqual([
      { from: 0, to: 21, severity: 'warning', message: 'DELETE 没有 WHERE 条件，会作用于整张表' },
    ])
  })

  it('stays quiet when the statement has its own WHERE', () => {
    expect(diags('UPDATE dwd_order SET amount = 1 WHERE order_id = 2')).toEqual([])
    expect(diags('DELETE FROM dwd_order WHERE order_id IN (SELECT order_id FROM dwd_order)')).toEqual([])
  })

  it('does not count a subquery WHERE as the statement WHERE', () => {
    expect(diags('UPDATE dwd_order SET amount = (SELECT 1 WHERE 1 = 1)')).toHaveLength(1)
  })

  it('warns per statement in a script', () => {
    expect(diags('UPDATE dwd_order SET amount = 1; DELETE FROM dwd_order')).toHaveLength(2)
  })
})

describe('sqlLintExtension', () => {
  let view: EditorView | undefined

  afterEach(() => {
    view?.destroy()
    view = undefined
    document.body.innerHTML = ''
  })

  function mount(doc: string, options: { schema?: SchemaIndex; knownTablesOnly?: boolean } = { schema }): EditorView {
    view = new EditorView({
      state: EditorState.create({ doc, extensions: [sqlLintExtension(options)] }),
      parent: document.body,
    })
    return view
  }

  it('underlines an unknown table in the editor', () => {
    const instance = mount('SELECT * FROM nope')
    const marks = [...instance.dom.querySelectorAll('.cm-sql-diag-error')]
    expect(marks.map(mark => mark.textContent)).toContain('nope')
  })

  it('recomputes on document changes and keeps decorations on selection changes', () => {
    const instance = mount('SELECT * FROM nope')
    expect(instance.dom.querySelector('.cm-sql-diag-error')).not.toBeNull()

    instance.dispatch({ selection: { anchor: 1 } })
    expect(instance.dom.querySelector('.cm-sql-diag-error')).not.toBeNull()

    instance.dispatch({ changes: { from: 14, to: 18, insert: 'dwd_order' } })
    expect(instance.dom.querySelector('.cm-sql-diag-error')).toBeNull()
  })

  it('paints warnings differently from errors', () => {
    const instance = mount('UPDATE dwd_order SET amount = 1')
    expect(instance.dom.querySelector('.cm-sql-diag-warning')).not.toBeNull()
  })

  it('honours knownTablesOnly', () => {
    const instance = mount('SELECT * FROM nope', { schema, knownTablesOnly: true })
    expect(instance.dom.querySelector('.cm-sql-diag-error')).toBeNull()
  })

  it('works without a schema snapshot', () => {
    const instance = mount('SELECT * FROM nope')
    expect(instance.dom.querySelector('.cm-sql-diag-error')).not.toBeNull()
    instance.dispatch({ changes: { from: 0, to: 18, insert: 'UPDATE dwd_order SET amount = 1' } })
    expect(instance.dom.querySelector('.cm-sql-diag-error')).toBeNull()
    expect(instance.dom.querySelector('.cm-sql-diag-warning')).not.toBeNull()
  })
})

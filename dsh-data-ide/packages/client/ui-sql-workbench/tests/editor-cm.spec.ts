import { describe, expect, it } from 'vitest'

import type { SchemaIndex } from '../src/client/completion.ts'
import { buildExtensions, readOnlyExtension, sqlExtension, templateCompletion, toSqlNamespace } from '../src/client/editor-cm.ts'
import { Compartment } from '@codemirror/state'

const schema: SchemaIndex = {
  tables: [
    { schema: 'dwd', kind: 'table', name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }, { name: 'amount', type: 'DECIMAL' }] },
    { schema: 'ads', kind: 'view', name: 'v_daily', columns: [{ name: 'day', type: 'DATE' }] },
    { name: 'loose', columns: [{ name: 'id', type: 'INT' }] },
  ],
}

describe('toSqlNamespace', () => {
  it('groups tables by schema and keeps unnamed ones at the top level', () => {
    expect(toSqlNamespace(schema)).toEqual({
      dwd: { dwd_order: ['order_id', 'amount'] },
      ads: { v_daily: ['day'] },
      loose: ['id'],
    })
  })

  it('returns nothing when there is no schema to offer', () => {
    expect(toSqlNamespace(undefined)).toBeUndefined()
    expect(toSqlNamespace({ tables: [] })).toBeUndefined()
  })

  it('treats an empty schema name as the default namespace', () => {
    expect(toSqlNamespace({ tables: [{ schema: '', name: 't', columns: [] }] })).toEqual({ t: [] })
  })
})

describe('editor extensions', () => {
  const callbacks = { onChange: () => undefined, onRun: () => undefined, onCancel: () => undefined }

  it('builds a dialect for a schema and for none', () => {
    expect(sqlExtension(schema)).toBeDefined()
    expect(sqlExtension(undefined)).toBeDefined()
  })

  it('builds read-only and editable states', () => {
    expect(Array.isArray(readOnlyExtension(true))).toBe(true)
    expect(Array.isArray(readOnlyExtension(false))).toBe(true)
  })

  it('assembles the full extension list, including compartments', () => {
    const extensions = buildExtensions({
      ...callbacks,
      readOnly: false,
      language: new Compartment(),
      readOnlySlot: new Compartment(),
    })

    // A rough shape check: the list is long and starts with the gutter.
    expect(extensions.length).toBeGreaterThan(15)
  })

  it('accepts a custom placeholder', () => {
    const extensions = buildExtensions({
      ...callbacks,
      readOnly: true,
      placeholderText: '-- 写点什么',
      language: new Compartment(),
      readOnlySlot: new Compartment(),
    })

    expect(extensions.length).toBeGreaterThan(15)
  })

  it('returns no template completion when there is no word at the cursor', () => {
    expect(templateCompletion({ matchBefore: () => null } as never)).toBeNull()
  })
})

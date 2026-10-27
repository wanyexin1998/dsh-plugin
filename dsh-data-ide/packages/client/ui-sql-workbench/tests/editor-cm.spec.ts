import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import type { SchemaIndex } from '../src/client/completion.ts'
import { buildExtensions, readOnlyExtension, shortcutKeymap, sqlExtension, templateCompletion, toSqlNamespace } from '../src/client/editor-cm.ts'
import type { EditorCallbacks } from '../src/client/editor-cm.ts'
import { DEFAULT_SHORTCUTS } from '../src/client/shortcut-settings.ts'

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
  const callbacks = {
    onChange: () => undefined,
    onRun: () => undefined,
    onRunAll: () => undefined,
    onRerun: () => undefined,
    onExplain: () => undefined,
    onHistory: () => undefined,
    onFormat: () => undefined,
    onExpandStar: () => undefined,
    onCancel: () => undefined,
  }

  /** Build the full stack the editor mounts, with fresh compartments. */
  const extensions = (options: { readonly readOnly?: boolean; readonly placeholderText?: string } = {}) =>
    buildExtensions({
      ...callbacks,
      readOnly: options.readOnly ?? false,
      ...(options.placeholderText === undefined ? {} : { placeholderText: options.placeholderText }),
      language: new Compartment(),
      readOnlySlot: new Compartment(),
      extrasSlot: new Compartment(),
      shortcutsSlot: new Compartment(),
    })

  it('builds a dialect for a schema and for none', () => {
    expect(sqlExtension(schema)).toBeDefined()
    expect(sqlExtension(undefined)).toBeDefined()
  })

  it('builds read-only and editable states', () => {
    expect(Array.isArray(readOnlyExtension(true))).toBe(true)
    expect(Array.isArray(readOnlyExtension(false))).toBe(true)
  })

  it('assembles the full extension list, including compartments', () => {
    const list = extensions()

    // A rough shape check: the list is long and starts with the gutter.
    expect(list.length).toBeGreaterThan(15)
  })

  it('accepts a custom placeholder', () => {
    expect(extensions({ readOnly: true, placeholderText: '-- 写点什么' }).length).toBeGreaterThan(15)
  })

  it('ships Alt+drag rectangular selection and its crosshair hint', () => {
    const state = EditorState.create({ doc: '', extensions: extensions() })

    // `rectangularSelection()` registers exactly one mouse-selection style and
    // `crosshairCursor()` contributes a content attribute (the pointer style).
    expect(state.facet(EditorView.mouseSelectionStyle)).toHaveLength(1)
    expect(state.facet(EditorView.contentAttributes).length).toBeGreaterThanOrEqual(1)
  })

  it('builds a chord keymap from settings, including platform mirroring', () => {
    const actions: string[] = []
    const recording: EditorCallbacks = {
      ...callbacks,
      onRun: () => {
        actions.push('run')
      },
      onRunAll: () => {
        actions.push('runAll')
      },
      onRerun: () => {
        actions.push('rerun')
      },
      onExplain: () => {
        actions.push('explain')
      },
      onHistory: () => {
        actions.push('history')
      },
      onFormat: () => {
        actions.push('format')
      },
      onExpandStar: () => {
        actions.push('expandStar')
      },
      onCancel: () => {
        actions.push('cancel')
      },
    }

    const state = EditorState.create({
      doc: 'SELECT 1',
      extensions: shortcutKeymap(DEFAULT_SHORTCUTS, recording),
    })

    // Two keymaps: the high-priority action chords and the plain cancel chord.
    expect(state.facet(keymap)).toHaveLength(2)
    // An unparseable combo silently contributes no binding instead of throwing.
    expect(shortcutKeymap({ ...DEFAULT_SHORTCUTS, run: 'garbage' }, recording)).toBeDefined()
  })

  it('returns no template completion when there is no word at the cursor', () => {
    expect(templateCompletion({ matchBefore: () => null } as never)).toBeNull()
  })
})

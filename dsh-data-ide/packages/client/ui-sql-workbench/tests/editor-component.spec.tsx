// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { currentCompletions } from '@codemirror/autocomplete'

import { SqlEditor } from '../src/client/components/SqlEditor.tsx'
import type { SqlEditorHandle } from '../src/client/components/SqlEditor.tsx'
import type { SchemaIndex } from '../src/client/completion.ts'
import { DEFAULT_SHORTCUTS } from '../src/client/shortcut-settings.ts'
import { contentDom, editorView, pressKey, readSql, setSql } from './support/editor.ts'

const schema: SchemaIndex = {
  tables: [{ schema: 'dwd', kind: 'table', name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }] }],
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let handle: SqlEditorHandle | null

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  handle = null
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.restoreAllMocks()
})

function render(props: Partial<React.ComponentProps<typeof SqlEditor>> = {}): void {
  const base = {
    sql: 'SELECT 1',
    running: false,
    disabled: false,
    onChange: vi.fn(),
    onRun: vi.fn(),
    onRunAll: vi.fn(),
    onRerun: vi.fn(),
    onExplain: vi.fn(),
    onHistory: vi.fn(),
    onFormat: vi.fn(),
    onExpandStar: vi.fn(),
    onCancel: vi.fn(),
    ...props,
  }
  act(() => {
    root.render(
      <SqlEditor
        ref={instance => {
          handle = instance
        }}
        {...base}
      />,
    )
  })
}

describe('sql editor (CodeMirror)', () => {
  it('mounts a CodeMirror editor showing the given SQL', () => {
    render()

    expect(container.querySelector('[data-sql-editor] .cm-editor')).not.toBeNull()
    expect(readSql(container)).toBe('SELECT 1')
    // The gutter and the active line come from the extensions, not from us.
    expect(container.querySelector('.cm-gutters')).not.toBeNull()
    expect(container.querySelector('.cm-activeLine')).not.toBeNull()
  })

  it('reports edits through onChange', () => {
    const onChange = vi.fn()
    render({ onChange })

    act(() => {
      setSql(container, 'SELECT 2')
    })

    expect(onChange).toHaveBeenCalledWith('SELECT 2')
  })

  it('follows a controlled value change from the panel', () => {
    render({ sql: 'SELECT 1' })

    act(() => {
      root.render(
        <SqlEditor
          ref={instance => {
            handle = instance
          }}
          sql="SELECT changed"
          running={false}
          disabled={false}
          onChange={vi.fn()}
          onRun={vi.fn()}
          onRunAll={vi.fn()}
          onRerun={vi.fn()}
          onExplain={vi.fn()}
          onHistory={vi.fn()}
          onFormat={vi.fn()}
          onExpandStar={vi.fn()}
          onCancel={vi.fn()}
        />,
      )
    })

    expect(readSql(container)).toBe('SELECT changed')
  })

  it('marks and clears the failing driver line', () => {
    render({ sql: 'SELECT 1\nFROM t\nWHERE' })

    act(() => {
      handle?.showErrorLine(3)
    })
    expect(container.querySelector('.cm-sql-error-line')).not.toBeNull()

    act(() => {
      handle?.showErrorLine(null)
    })
    expect(container.querySelector('.cm-sql-error-line')).toBeNull()
  })

  it('exposes the caret offset for statement-scoped actions', () => {
    render({ sql: 'SELECT 1' })
    expect(handle?.getCursor()).toBeGreaterThan(0)
  })

  it('inserts text at the caret and reads the selection back', () => {
    const onChange = vi.fn()
    render({ sql: 'SELECT ', onChange })

    act(() => {
      handle?.insert('order_id')
    })

    expect(readSql(container)).toBe('SELECT order_id')
    expect(handle?.getSelection()).toBe('')

    act(() => {
      setSql(container, 'SELECT col FROM t')
    })
    const view = container.querySelector('[data-sql-editor] .cm-content')
    expect(view).not.toBeNull()
  })

  it('runs on Ctrl/Cmd+Enter and cancels on Escape', () => {
    const onRun = vi.fn()
    const onCancel = vi.fn()
    render({ onRun, onCancel })

    act(() => {
      pressKey(container, { key: 'Enter', ctrlKey: true })
    })
    expect(onRun).toHaveBeenCalledTimes(1)

    act(() => {
      pressKey(container, { key: 'Enter', metaKey: true })
    })
    expect(onRun).toHaveBeenCalledTimes(2)

    act(() => {
      pressKey(container, { key: 'Escape' })
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('keeps the editor free of a query toolbar', () => {
    render({ sql: 'SELECT 1\nFROM t' })

    expect(container.querySelector('[data-sql-editor-bar]')).toBeNull()
    expect(container.querySelector('[data-sql-editor]')).not.toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('binds run-all and rerun to their own chords', () => {
    const onRun = vi.fn()
    const onRunAll = vi.fn()
    const onRerun = vi.fn()
    const onExplain = vi.fn()
    render({ onRun, onRunAll, onRerun, onExplain })

    act(() => {
      pressKey(container, { key: 'Enter', ctrlKey: true, shiftKey: true })
    })
    expect(onRunAll).toHaveBeenCalledTimes(1)
    expect(onRun).not.toHaveBeenCalled()

    act(() => {
      pressKey(container, { key: 'Enter', ctrlKey: true, altKey: true })
    })
    expect(onRerun).toHaveBeenCalledTimes(1)

    act(() => {
      pressKey(container, { key: 'e', ctrlKey: true, shiftKey: true })
    })
    expect(onExplain).toHaveBeenCalledTimes(1)
  })

  it('binds format and star-expansion to their chords', () => {
    const onFormat = vi.fn()
    const onExpandStar = vi.fn()
    render({ onFormat, onExpandStar, sql: 'SELECT * FROM t' })

    act(() => {
      pressKey(container, { key: 'l', ctrlKey: true, altKey: true })
    })
    expect(onFormat).toHaveBeenCalledTimes(1)

    act(() => {
      pressKey(container, { key: 's', ctrlKey: true, altKey: true })
    })
    expect(onExpandStar).toHaveBeenCalledTimes(1)
  })

  it('binds Ctrl+Shift+H to the history drawer', () => {
    const onHistory = vi.fn()
    render({ onHistory })

    act(() => {
      pressKey(container, { key: 'h', ctrlKey: true, shiftKey: true })
    })
    expect(onHistory).toHaveBeenCalledTimes(1)
  })

  it('exposes the current selection range to the panel', () => {
    render({ sql: 'SELECT 1' })
    act(() => {
      handle?.replaceRange(0, 0, 'X')
    })
    const range = handle?.getSelectionRange()
    expect(range?.from).toBe(1)
    expect(range?.to).toBe(1)
  })

  it('marks the editor read-only without a connection and flags a running query', () => {
    render({ disabled: true, sql: 'SELECT 1' })
    expect(container.querySelector('[data-sql-editor]')?.getAttribute('aria-readonly')).toBe('true')

    act(() => {
      root.render(
        <SqlEditor
          sql="SELECT 1"
          running
          disabled={false}
          onChange={vi.fn()}
          onRun={vi.fn()}
          onRunAll={vi.fn()}
          onRerun={vi.fn()}
          onExplain={vi.fn()}
          onHistory={vi.fn()}
          onFormat={vi.fn()}
          onExpandStar={vi.fn()}
          onCancel={vi.fn()}
        />,
      )
    })
    expect(container.querySelector('[data-sql-running]')).not.toBeNull()
  })

  it('accepts a schema for completion without remounting the view', () => {
    render({ schema: undefined })
    const before = container.querySelector('.cm-editor')

    act(() => {
      root.render(
        <SqlEditor
          ref={instance => {
            handle = instance
          }}
          sql="SELECT 1"
          running={false}
          disabled={false}
          schema={schema}
          onChange={vi.fn()}
          onRun={vi.fn()}
          onRunAll={vi.fn()}
          onRerun={vi.fn()}
          onExplain={vi.fn()}
          onHistory={vi.fn()}
          onFormat={vi.fn()}
          onExpandStar={vi.fn()}
          onCancel={vi.fn()}
        />,
      )
    })

    // Same view instance: the dialect is swapped through a compartment.
    expect(container.querySelector('.cm-editor')).toBe(before)
    expect(readSql(container)).toBe('SELECT 1')
  })

  it('honours custom shortcut settings on mount', () => {
    const onRun = vi.fn()
    render({ onRun, shortcuts: { ...DEFAULT_SHORTCUTS, run: 'Alt+R' } })

    act(() => {
      pressKey(container, { key: 'r', altKey: true })
    })
    expect(onRun).toHaveBeenCalledTimes(1)
  })

  it('reconfigures the keymap in place when the settings change', () => {
    const onRun = vi.fn()
    const onCancel = vi.fn()
    render({ onRun, onCancel })
    const editor = container.querySelector('.cm-editor')

    act(() => {
      pressKey(container, { key: 'Enter', ctrlKey: true })
    })
    expect(onRun).toHaveBeenCalledTimes(1)

    render({ onRun, onCancel, shortcuts: { ...DEFAULT_SHORTCUTS, run: 'Alt+R', cancel: 'Ctrl+.' } })
    // Same CodeMirror view: only the chord compartment was reconfigured.
    expect(container.querySelector('.cm-editor')).toBe(editor)

    act(() => {
      pressKey(container, { key: 'Enter', ctrlKey: true })
    })
    expect(onRun).toHaveBeenCalledTimes(1)

    act(() => {
      pressKey(container, { key: 'r', altKey: true })
    })
    expect(onRun).toHaveBeenCalledTimes(2)

    act(() => {
      pressKey(container, { key: '.', ctrlKey: true })
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows the Alt crosshair while Alt is held, the column-selection affordance', () => {
    render()
    const content = contentDom(container)

    act(() => {
      content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', keyCode: 18, altKey: true, bubbles: true }))
    })
    expect(content.style.cursor).toBe('crosshair')

    act(() => {
      content.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', keyCode: 18, bubbles: true }))
    })
    expect(content.style.cursor).toBe('')
  })

  it('keeps the pre-settings chords working when no settings are passed', () => {
    const onRun = vi.fn()
    render({ onRun })

    act(() => {
      pressKey(container, { key: 'Enter', metaKey: true })
    })

    expect(onRun).toHaveBeenCalledTimes(1)
  })

  it('opens completion from a custom chord and accepts it with the configured key', async () => {
    const shortcuts = { ...DEFAULT_SHORTCUTS, complete: 'Alt+C', acceptCompletion: 'Alt+A' }
    render({ sql: 'SEL', shortcuts })

    act(() => {
      pressKey(container, { key: 'c', altKey: true })
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(currentCompletions(editorView(container).state).length).toBeGreaterThan(0)
    // The library refuses to accept a completion within `interactionDelay`
    // (75ms) of the popup opening; let that window pass deterministically.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 120))
    })

    act(() => {
      pressKey(container, { key: 'a', altKey: true })
    })

    expect(readSql(container)).toMatch(/^SELECT/i)
  })

  it('accepts completion with Enter, and keeps Enter as a newline when no popup is open', async () => {
    render({ sql: 'SEL' })

    act(() => {
      pressKey(container, { key: ' ', ctrlKey: true })
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(currentCompletions(editorView(container).state).length).toBeGreaterThan(0)
    // Let the library's 75ms interaction delay pass before accepting.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 120))
    })

    act(() => {
      pressKey(container, { key: 'Enter' })
    })
    expect(readSql(container)).toMatch(/^SELECT/i)

    // With no popup open the accept handler returns false, so Enter reaches the
    // editor's default newline binding instead of being swallowed.
    const lines = readSql(container).split('\n').length
    act(() => {
      pressKey(container, { key: 'Enter' })
    })
    expect(readSql(container).split('\n').length).toBe(lines + 1)
  })
})

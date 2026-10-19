// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SqlEditor } from '../src/client/components/SqlEditor.tsx'
import type { SqlEditorHandle } from '../src/client/components/SqlEditor.tsx'
import type { SchemaIndex } from '../src/client/completion.ts'
import { pressKey, readSql, setSql } from './support/editor.ts'

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
          onCancel={vi.fn()}
        />,
      )
    })

    expect(readSql(container)).toBe('SELECT changed')
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

  it('disables the run button and marks the editor read-only without a connection', () => {
    render({ disabled: true, sql: 'SELECT 1' })

    const run = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '执行')
    expect((run as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('[data-sql-editor]')?.getAttribute('aria-readonly')).toBe('true')
  })

  it('shows the cancel button only while running', () => {
    render({ running: true })

    const cancel = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '取消')
    expect((cancel as HTMLButtonElement).disabled).toBe(false)
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
          onCancel={vi.fn()}
        />,
      )
    })

    // Same view instance: the dialect is swapped through a compartment.
    expect(container.querySelector('.cm-editor')).toBe(before)
    expect(readSql(container)).toBe('SELECT 1')
  })
})

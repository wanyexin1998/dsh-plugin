import * as React from 'react'

import type { ReactElement, Ref } from 'react'

import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import type { SchemaIndex } from '../completion.ts'
import { buildExtensions, readOnlyExtension, sqlExtension } from '../editor-cm.ts'
import { classes as styles } from '../styles.ts'

export interface SqlEditorProps {
  readonly sql: string
  readonly running: boolean
  /** True when no connection is selected, or the host service is missing. */
  readonly disabled: boolean
  /** Tables and columns for completion; absent means keywords only. */
  readonly schema?: SchemaIndex
  readonly onChange: (sql: string) => void
  readonly onRun: () => void
  readonly onCancel: () => void
}

/**
 * Imperative surface other parts of the panel use.
 *
 * `insert` focuses the editor as part of inserting (that is the gesture the
 * object tree needs); there is deliberately no bare `focus()` — nothing called
 * it, and dead API is not free.
 */
export interface SqlEditorHandle {
  /** Insert text at the caret (or over the selection) and keep the caret after it. */
  insert(text: string): void
  /** Selected text; an empty string when the caret is collapsed (run-selection). */
  getSelection(): string
}

/**
 * SQL editor, backed by CodeMirror 6.
 *
 * Why the swap: the previous version was a transparent `<textarea>` plus a
 * painted `<pre>`, with our own tokeniser, caret mirror, bracket matcher and
 * completion popup. That worked, but it could not do folding, find/replace,
 * multi-cursor, `Ctrl+/`, block indent or go-to-line — the things you notice the
 * moment a script grows past a few lines. CodeMirror's `lang-sql` also brings
 * schema-aware completion (table + column, including `alias.`), so the
 * hand-rolled engine is gone.
 *
 * The panel contract is unchanged on purpose: `SqlEditorHandle`, the toolbar and
 * the props are the same, so `SqlWorkbenchPanel` did not have to move.
 */
function SqlEditorImpl(
  { sql, running, disabled, schema, onChange, onRun, onCancel }: SqlEditorProps,
  ref: Ref<SqlEditorHandle>,
): ReactElement {
  const host = React.useRef<HTMLDivElement | null>(null)
  const view = React.useRef<EditorView | null>(null)
  /**
   * Latest props for the extensions, which are built once.
   *
   * Rebuilding extensions on every prop change would reset undo history and the
   * selection, so the key handlers read through refs instead.
   */
  const callbacks = React.useRef({ onChange, onRun, onCancel, schema })
  callbacks.current = { onChange, onRun, onCancel, schema }

  React.useImperativeHandle(ref, () => ({
    insert(text: string) {
      const instance = view.current
      /* v8 ignore next -- the view exists while the editor is mounted */
      if (instance === null) return
      const { from, to } = instance.state.selection.main
      instance.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      })
      instance.focus()
    },
    getSelection() {
      const instance = view.current
      /* v8 ignore next -- the view exists for the life of the mounted editor */
      if (instance === null) return ''
      const { from, to } = instance.state.selection.main
      return instance.state.sliceDoc(from, to)
    },
  }), [])

  // Compartments for the two things that change after mount.
  const [slots] = React.useState(() => ({ language: new Compartment(), readOnlySlot: new Compartment() }))

  // Mount once; later prop changes are applied as compartment reconfigurations,
  // so undo history and the selection survive a schema refresh.
  React.useEffect(() => {
    const parent = host.current
    /* v8 ignore next -- the host div is rendered as part of this component */
    if (parent === null) return
    const instance = new EditorView({
      parent,
      state: EditorState.create({
        doc: sql,
        // Caret at the end: a console opened with SQL in it should accept an
        // object-tree insert where the text stops, not before it.
        selection: { anchor: sql.length },
        extensions: buildExtensions({
        readOnly: false,
        language: slots.language,
        readOnlySlot: slots.readOnlySlot,
        ...(callbacks.current.schema === undefined ? {} : { schema: callbacks.current.schema }),
        onChange: doc => {
          callbacks.current.onChange(doc)
        },
        onRun: () => {
          callbacks.current.onRun()
        },
          onCancel: () => {
            callbacks.current.onCancel()
          },
        }),
      }),
    })
    view.current = instance
    return () => {
      instance.destroy()
      view.current = null
    }
    // Mount only: prop changes are handled by the effects below.
  }, [])

  // Controlled value: replace the document only when it really differs, so
  // typing does not fight the state round-trip through the panel.
  React.useEffect(() => {
    const instance = view.current
    /* v8 ignore next -- the effect runs after mount */
    if (instance === null) return
    const current = instance.state.doc.toString()
    if (current === sql) return
    instance.dispatch({
      changes: { from: 0, to: current.length, insert: sql },
      selection: { anchor: sql.length },
    })
  }, [sql])

  // Schema arrives asynchronously: swap the dialect (and its completion source)
  // in place instead of remounting.
  React.useEffect(() => {
    const instance = view.current
    /* v8 ignore next -- the effect runs after mount */
    if (instance === null) return
    instance.dispatch({ effects: slots.language.reconfigure(sqlExtension(schema)) })
  }, [schema, slots])

  // Read-only follows the panel's "no connection" state.
  React.useEffect(() => {
    const instance = view.current
    /* v8 ignore next -- the effect runs after mount */
    if (instance === null) return
    instance.dispatch({ effects: slots.readOnlySlot.reconfigure(readOnlyExtension(disabled)) })
  }, [disabled, slots])

  return (
    <div className={styles.editor}>
      <div className={styles.editorBar}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={disabled || running || sql.trim() === ''}
          onClick={() => {
            onRun()
          }}
          aria-label="执行"
        >
          执行
        </button>
        <button type="button" className={styles.button} disabled={!running} onClick={onCancel} aria-label="取消">
          取消
        </button>
        <span className={styles.hint}>
          Ctrl/Cmd+Enter 执行（有选中则只跑选段） · Ctrl+Space 补全 · Ctrl+F 查找 · Ctrl+/ 注释 · Esc 取消
        </span>
      </div>
      <div
        className={styles.editorHost}
        ref={host}
        data-sql-editor=""
        aria-label="SQL 语句"
        aria-readonly={disabled ? 'true' : 'false'}
      />
    </div>
  )
}

/** Forwarding component so the panel can insert names from the object tree. */
export const SqlEditor = React.forwardRef(SqlEditorImpl)

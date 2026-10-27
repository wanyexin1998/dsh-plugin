import * as React from 'react'

import type { ReactElement, Ref } from 'react'

import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import type { SchemaIndex } from '../completion.ts'
import {
  buildExtensions,
  readOnlyExtension,
  shortcutKeymap,
  showErrorLine as showEditorErrorLine,
  sqlExtension,
} from '../editor-cm.ts'
import type { EditorAim, RunTarget } from '../editor-cm.ts'
import { DEFAULT_SHORTCUTS } from '../shortcut-settings.ts'
import type { ShortcutSettings } from '../shortcut-settings.ts'
import { buildExtrasExtension } from '../sql-extras.ts'
import { classes as styles } from '../styles.ts'

export interface SqlEditorProps {
  readonly sql: string
  readonly running: boolean
  /** True when no connection is selected, or the host service is missing. */
  readonly disabled: boolean
  /** Tables and columns for completion; absent means keywords only. */
  readonly schema?: SchemaIndex
  readonly onChange: (sql: string) => void
  readonly onRun: (target: RunTarget) => void
  /** Run the whole script (`Ctrl/Cmd+Shift+Enter`). */
  readonly onRunAll: (target: RunTarget) => void
  /** Repeat the previous run (`Ctrl/Cmd+Alt+Enter`). */
  readonly onRerun: () => void
  /** EXPLAIN the statement at the caret (`Ctrl/Cmd+Shift+E`). */
  readonly onExplain: (target: RunTarget) => void
  /** Open the query-history drawer (`Ctrl/Cmd+Shift+H`). */
  readonly onHistory: () => void
  /** Format the selection or the whole document (`Ctrl/Cmd+Alt+L`). */
  readonly onFormat: (target: RunTarget) => void
  /** Expand `*` into the column list (`Ctrl/Cmd+Alt+S`). */
  readonly onExpandStar: (target: RunTarget) => void
  /** Inline diagnostics on/off (SQL-309); default on. */
  readonly lintEnabled?: boolean
  /** User-editable chords (SQL-402); defaults keep the pre-settings bindings. */
  readonly shortcuts?: ShortcutSettings
  readonly onCancel: () => void
  /** Caret or selection moved. The panel uses this to name the run button. */
  readonly onAim?: (aim: EditorAim) => void
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
  /** Highlight/scroll to the failing statement line (`null` clears it). */
  showErrorLine(line: number | null): void
  /** Caret offset, for actions that operate on the statement under it. */
  getCursor(): number
  /** Move the caret (restoring a persisted console position). */
  setCursor(offset: number): void
  /** Current selection offsets (equal when collapsed). */
  getSelectionRange(): { readonly from: number; readonly to: number }
  /** Replace `[from, to)` with text (formatting / star expansion). */
  replaceRange(from: number, to: number, text: string): void
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
 * The run button lives on the console strip, not here: a 420px rail cannot spend
 * a row on nine labelled actions. Chords still call the same callbacks.
 */
/** Caret updates are not shown in the editor; the console strip owns the chrome. */
function ignoreCursor(_info: unknown): void {
  return undefined
}

function SqlEditorImpl(
  { sql, running, disabled, schema, onChange, onRun, onRunAll, onRerun, onExplain, onHistory, onFormat, onExpandStar, lintEnabled = true, shortcuts, onCancel, onAim }: SqlEditorProps,
  ref: Ref<SqlEditorHandle>,
): ReactElement {
  const activeShortcuts = shortcuts ?? DEFAULT_SHORTCUTS
  const host = React.useRef<HTMLDivElement | null>(null)
  const view = React.useRef<EditorView | null>(null)
  /**
   * Latest props for the extensions, which are built once.
   *
   * Rebuilding extensions on every prop change would reset undo history and the
   * selection, so the key handlers read through refs instead.
   */
  const callbacks = React.useRef({ onChange, onRun, onRunAll, onRerun, onExplain, onHistory, onFormat, onExpandStar, onCancel, onCursor: ignoreCursor, onAim, schema })
  callbacks.current = { onChange, onRun, onRunAll, onRerun, onExplain, onHistory, onFormat, onExpandStar, onCancel, onCursor: ignoreCursor, onAim, schema }

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
    showErrorLine(line: number | null) {
      const instance = view.current
      /* v8 ignore next -- the view exists for the life of the mounted editor */
      if (instance === null) return
      showEditorErrorLine(instance, line)
    },
    getCursor() {
      const instance = view.current
      /* v8 ignore next -- the view exists for the life of the mounted editor */
      if (instance === null) return 0
      return instance.state.selection.main.head
    },
    setCursor(offset: number) {
      const instance = view.current
      /* v8 ignore next -- the view exists for the life of the mounted editor */
      if (instance === null) return
      const position = Math.min(Math.max(0, Math.trunc(offset)), instance.state.doc.length)
      instance.dispatch({ selection: { anchor: position } })
    },
    getSelectionRange() {
      const instance = view.current
      /* v8 ignore next -- the view exists for the life of the mounted editor */
      if (instance === null) return { from: 0, to: 0 }
      const range = instance.state.selection.main
      return { from: range.from, to: range.to }
    },
    replaceRange(from: number, to: number, text: string) {
      const instance = view.current
      /* v8 ignore next -- the view exists for the life of the mounted editor */
      if (instance === null) return
      const start = Math.min(Math.max(0, from), instance.state.doc.length)
      const end = Math.min(Math.max(start, to), instance.state.doc.length)
      instance.dispatch({
        changes: { from: start, to: end, insert: text },
        selection: { anchor: start + text.length },
      })
      instance.focus()
    },
  }), [])

  // Compartments for the parts that change after mount.
  const [slots] = React.useState(() => ({
    language: new Compartment(),
    readOnlySlot: new Compartment(),
    extrasSlot: new Compartment(),
    shortcutsSlot: new Compartment(),
  }))

  // Mount once; later prop changes are applied as compartment reconfigurations,
  // so undo history and the selection survive a schema refresh.
  React.useEffect(() => {
    const parent = host.current
    /* v8 ignore next -- the host div is rendered as part of this component */
    if (parent === null) return
    // No schema at mount: it arrives asynchronously and the effect below swaps
    // the dialect in. Passing it here (always undefined on first paint) would be
    // a branch nobody can reach.
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
          extrasSlot: slots.extrasSlot,
          shortcutsSlot: slots.shortcutsSlot,
          shortcuts: activeShortcuts,
          extras: buildExtrasExtension({ schema, lint: lintEnabled }),
          onChange: doc => {
            callbacks.current.onChange(doc)
          },
          onRun: target => {
            callbacks.current.onRun(target)
          },
          onRunAll: target => {
            callbacks.current.onRunAll(target)
          },
          onRerun: () => {
            callbacks.current.onRerun()
          },
          onExplain: target => {
            callbacks.current.onExplain(target)
          },
          onHistory: () => {
            callbacks.current.onHistory()
          },
          onFormat: target => {
            callbacks.current.onFormat(target)
          },
          onExpandStar: target => {
            callbacks.current.onExpandStar(target)
          },
          onCursor: info => {
            callbacks.current.onCursor(info)
          },
          onAim: aim => {
            callbacks.current.onAim?.(aim)
          },
          onCancel: () => {
            callbacks.current.onCancel()
          },
        }),
      }),
    })
    view.current = instance
    const range = instance.state.selection.main
    callbacks.current.onAim?.({
      cursor: range.head,
      from: range.from,
      to: range.to,
      doc: instance.state.doc.toString(),
    })
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

  // Schema or the diagnostics switch arrived/changed: swap the dialect and the
  // intelligence extras in place instead of remounting (undo history survives).
  React.useEffect(() => {
    const instance = view.current
    /* v8 ignore next -- the effect runs after mount */
    if (instance === null) return
    instance.dispatch({
      effects: [
        slots.language.reconfigure(sqlExtension(schema)),
        slots.extrasSlot.reconfigure(buildExtrasExtension({ schema, lint: lintEnabled })),
      ],
    })
  }, [schema, lintEnabled, slots])

  // Read-only follows the panel's "no connection" state.
  React.useEffect(() => {
    const instance = view.current
    /* v8 ignore next -- the effect runs after mount */
    if (instance === null) return
    instance.dispatch({ effects: slots.readOnlySlot.reconfigure(readOnlyExtension(disabled)) })
  }, [disabled, slots])

  // Shortcut settings changed after mount: swap only the chord keymap, so the
  // document, undo history and selection are untouched. The first run is skipped
  // because the mount effect already built the keymap from these settings.
  const shortcutsReady = React.useRef(false)
  React.useEffect(() => {
    if (!shortcutsReady.current) {
      shortcutsReady.current = true
      return
    }
    const instance = view.current
    /* v8 ignore next -- the effect runs while the editor is mounted */
    if (instance === null) return
    instance.dispatch({
      effects: slots.shortcutsSlot.reconfigure(shortcutKeymap(activeShortcuts, callbacks.current)),
    })
  }, [shortcuts, slots])

  return (
    <div className={styles.editor} data-sql-running={running ? '' : undefined}>
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

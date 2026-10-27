/**
 * CodeMirror 6 assembly for the SQL editor.
 *
 * The previous editor was a transparent `<textarea>` with a painted layer, which
 * meant hand-writing tokenising, bracket matching, a caret mirror, a completion
 * popup and a line-number gutter (≈900 lines) — and still having no folding, no
 * find/replace, no multi-cursor and no `Ctrl+/`.
 *
 * CodeMirror 6 replaces that engine. This module is the only place that knows
 * about it: extensions, theme and key bindings. `SqlEditor.tsx` keeps the panel
 * contract (`SqlEditorHandle`, props) unchanged.
 *
 * Notes for anyone touching this:
 *  - styles are injected through `EditorView.theme`, so no extra CSS file has to
 *    travel through the host's bundle contract;
 *  - every colour is a `--dsw-*` token, so light/dark follows the shell;
 *  - the SQL dialect carries the completion schema, which is why the old
 *    `completion.ts` engine is no longer wired to the editor.
 */

import {
  type CompletionSource,
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
  startCompletion,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands'
import { MySQL, sql } from '@codemirror/lang-sql'
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  type KeyBinding,
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'

import type { SchemaIndex } from './completion.ts'
import { keywordBoost, matchingTemplates } from './completion-rank.ts'
import {
  DEFAULT_SHORTCUTS,
  KEYBOUND_SHORTCUT_ACTIONS,
  keySpecs,
} from './shortcut-settings.ts'
import type { ShortcutSettings } from './shortcut-settings.ts'

/** Namespace shape `@codemirror/lang-sql` accepts: `{ schema: { table: [cols] } }`. */
export type SqlNamespace = Readonly<Record<string, Readonly<Record<string, readonly string[]>> | readonly string[]>>

/**
 * Turn the panel's schema snapshot into the completion namespace.
 *
 * Tables without a `schema` (the SHOW fallback of a connection that names its
 * database) are folded into one unnamed namespace, which the dialect treats as
 * the default — so `SELECT * FROM dwd_` still offers them.
 */
export function toSqlNamespace(schema: SchemaIndex | undefined): SqlNamespace | undefined {
  if (schema === undefined || schema.tables.length === 0) return undefined
  const named = new Map<string, Record<string, string[]>>()
  const flat: Record<string, string[]> = {}
  for (const table of schema.tables) {
    const columns = table.columns.map(column => column.name)
    if (table.schema === undefined || table.schema === '') {
      flat[table.name] = columns
      continue
    }
    const group = named.get(table.schema) ?? {}
    group[table.name] = columns
    named.set(table.schema, group)
  }
  const namespace: Record<string, Record<string, string[]> | string[]> = { ...flat }
  for (const [schemaName, tables] of named) namespace[schemaName] = tables
  return namespace
}

/**
 * Chinese labels for CodeMirror's own UI (search panel, mostly).
 *
 * The library ships English phrases; the rest of the panel is Chinese, and a
 * mixed-language search box reads like a bug.
 */
export const PHRASES: Readonly<Record<string, string>> = {
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全部',
  'match case': '区分大小写',
  regexp: '正则',
  'by word': '整词',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'current match': '当前匹配',
  'on line': '第几行',
  'replaced $ matches': '已替换 $ 处',
  'replaced match on line $': '已替换第 $ 行的匹配',
  'Go to line': '跳到行',
  go: '跳转',
}

/** Token colours, all from the shell's palette. */
export const sqlHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--dsw-alias-state-business-primary)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--dsw-alias-state-success-primary)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--dsw-alias-state-warn-primary)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--dsw-alias-label-tertiary)', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--dsw-alias-label-secondary)' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--dsw-alias-label-primary)' },
])

/**
 * Editor chrome: one theme, no border of its own.
 *
 * The panel card already draws the frame, so the editor must not add another.
 */
export const sqlEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--dsw-alias-label-primary)',
    backgroundColor: 'var(--dsw-alias-markdown-code-block)',
    fontSize: 'var(--dsw-font-s-14)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--ds-font-family-code)',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--dsw-alias-label-primary)', padding: '6px 0' },
  '.cm-line': { padding: '0 10px' },
  '.cm-gutters': {
    color: 'var(--dsw-alias-label-tertiary)',
    backgroundColor: 'transparent',
    border: 'none',
    paddingLeft: '4px',
  },
  '.cm-activeLine': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover)' },
  '.cm-activeLineGutter': {
    color: 'var(--dsw-alias-label-secondary)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--dsw-alias-interactive-bg-hover)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--dsw-alias-label-primary)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--dsw-alias-interactive-bg-hover)',
    outline: '1px solid var(--dsw-alias-border-l2)',
  },
  '.cm-foldPlaceholder': {
    color: 'var(--dsw-alias-label-tertiary)',
    backgroundColor: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '4px',
    padding: '0 4px',
  },
  '.cm-tooltip': {
    color: 'var(--dsw-alias-label-primary)',
    backgroundColor: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    boxShadow: '0 12px 28px -12px var(--dsw-alias-border-l2)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--ds-font-family-code)',
    maxHeight: '220px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    color: 'var(--dsw-alias-bg-base)',
    backgroundColor: 'var(--dsw-alias-state-business-primary)',
  },
  '.cm-completionDetail': { color: 'var(--dsw-alias-label-tertiary)', fontStyle: 'normal' },
  '.cm-panels': {
    color: 'var(--dsw-alias-label-primary)',
    backgroundColor: 'var(--dsw-alias-bg-layer-1)',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--dsw-alias-border-l1)' },
  // The search panel ships as a two-row block of large controls; in a 300px
  // result column it ate the editor. Compact it, keep it on one line if it fits.
  '.cm-search': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px 6px',
    padding: '4px 6px',
    fontSize: 'var(--dsw-font-s-12)',
  },
  '.cm-search label': {
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 'var(--dsw-font-s-11)',
  },
  '.cm-textfield': {
    height: '22px',
    padding: '0 6px',
    color: 'var(--dsw-alias-label-primary)',
    backgroundColor: 'var(--dsw-alias-bg-base)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '4px',
    fontSize: 'var(--dsw-font-s-12)',
  },
  '.cm-button': {
    height: '22px',
    padding: '0 6px',
    color: 'var(--dsw-alias-label-secondary)',
    backgroundColor: 'var(--dsw-alias-bg-base)',
    backgroundImage: 'none',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '4px',
    fontSize: 'var(--dsw-font-s-11)',
  },
  '.cm-search button[name=close]': {
    position: 'static',
    order: 99,
    marginLeft: 'auto',
    padding: '0 4px',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: 'var(--dsw-font-s-12)',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--dsw-alias-state-warn-primary)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--dsw-alias-state-business-primary)' },
  // The statement line a driver error points at (SQL-304).
  '.cm-sql-error-line': {
    backgroundColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)',
    boxShadow: 'inset 2px 0 0 var(--dsw-alias-state-error-primary)',
  },
})

/** What the user asked to run: the full document, the selection, and the caret. */
export interface RunTarget {
  /** Whole editor text at the moment of the action (React state may lag a tick). */
  readonly doc: string
  readonly selection: string
  readonly cursor: number
  /** Selection offsets (equal when the caret is collapsed). */
  readonly from: number
  readonly to: number
}

/** Caret/selection summary for the editor status strip. */
export interface CursorInfo {
  readonly line: number
  readonly column: number
  readonly selectedChars: number
}

export interface EditorCallbacks {
  readonly onChange: (doc: string) => void
  /** `Ctrl/Cmd+Enter`, or the toolbar button. */
  readonly onRun: (target: RunTarget) => void
  /** `Ctrl/Cmd+Shift+Enter`: run the whole script. */
  readonly onRunAll: (target: RunTarget) => void
  /** `Ctrl/Cmd+Alt+Enter`: repeat the previous run. */
  readonly onRerun: () => void
  /** `Ctrl/Cmd+Shift+E` or the toolbar: run EXPLAIN for the statement at the caret. */
  readonly onExplain: (target: RunTarget) => void
  /** `Ctrl/Cmd+Shift+H` or the toolbar: open query history. */
  readonly onHistory: () => void
  /** `Ctrl/Cmd+Alt+L` or the toolbar: format the selection or the whole document. */
  readonly onFormat: (target: RunTarget) => void
  /** `Ctrl/Cmd+Alt+S` or the toolbar: expand `*` into the column list. */
  readonly onExpandStar: (target: RunTarget) => void
  /** `Escape` when no completion popup is open. */
  readonly onCancel: () => void
  /** Caret/selection changed, for the status strip. */
  readonly onCursor?: (info: CursorInfo) => void
  /** Live caret and selection, so the run button can name what a click will run. */
  readonly onAim?: (aim: EditorAim) => void
}

/** Offsets the run button uses to tell a read from a write. */
export interface EditorAim {
  readonly cursor: number
  readonly from: number
  readonly to: number
  readonly doc: string
}

/** Line/column/selection length for one editor state. */
export function cursorInfoOf(state: EditorState): CursorInfo {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  let selectedChars = 0
  for (const range of state.selection.ranges) selectedChars += range.to - range.from
  return { line: line.number, column: head - line.from + 1, selectedChars }
}

/** Caret, selection and document for one editor state. */
export function aimOf(state: EditorState): EditorAim {
  const range = state.selection.main
  return { cursor: range.head, from: range.from, to: range.to, doc: state.doc.toString() }
}

/** Marks (or clears) the failing statement line; value is 1-based. */
export const errorLineEffect = StateEffect.define<number | null>()

/** Decoration for one line number, clamped into the document. */
function errorLineDecoration(state: EditorState, line: number | null): DecorationSet {
  if (line === null) return Decoration.none
  const document = state.doc
  const target = document.line(Math.min(Math.max(1, Math.trunc(line)), document.lines))
  return Decoration.set([Decoration.line({ class: 'cm-sql-error-line' }).range(target.from)])
}

/** Editor decoration backing `showErrorLine`; survives ordinary edits. */
export const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(errorLineEffect)) next = errorLineDecoration(transaction.state, effect.value)
    }
    return next
  },
  provide: field => EditorView.decorations.from(field),
})

/**
 * Highlight and scroll to one error line, or clear the highlight with `null`.
 *
 * @param view - Editor view to update.
 * @param line - 1-based line the driver complained about.
 */
export function showErrorLine(view: EditorView, line: number | null): void {
  const effects: StateEffect<unknown>[] = [errorLineEffect.of(line)]
  if (line !== null) {
    const document = view.state.doc
    const target = document.line(Math.min(Math.max(1, Math.trunc(line)), document.lines))
    effects.push(EditorView.scrollIntoView(target.from, { y: 'center' }))
  }
  view.dispatch({ effects })
}

/** The SQL dialect (and therefore the completion source) for one schema snapshot. */
export function sqlExtension(schema: SchemaIndex | undefined): Extension {
  const namespace = toSqlNamespace(schema)
  return sql({
    dialect: MySQL,
    upperCaseKeywords: true,
    /**
     * Ordering, not filtering: CodeMirror's keyword list is alphabetical, so `S`
     * offered `SAVEPOINT`/`SCHEMA`/`SCROLL` and pushed `SELECT` below the fold.
     * `boost` is added to the match score, so everyday words now lead.
     */
    keywordCompletion: (label, type) => ({ label: label.toUpperCase(), type, boost: keywordBoost(label) }),
    ...(namespace === undefined ? {} : { schema: namespace }),
  })
}

/**
 * Live templates (`sel`, `selw`, `ins`, …), the way DataGrip users start a query.
 *
 * A second source rather than part of the keyword list: these are **words the
 * user types**, not SQL keywords, and a boost high enough to beat every keyword
 * keeps them on top when the prefix matches.
 */
export const templateCompletion: CompletionSource = context => {
  const word = context.matchBefore(/\w*/)
  if (word === null) return null
  const templates = matchingTemplates(word.text)
  if (templates.length === 0) return null
  return {
    from: word.from,
    options: templates.map(template =>
      snippetCompletion(template.snippet, {
        label: template.label,
        detail: template.detail,
        type: 'text',
        boost: 30,
      }),
    ),
    validFor: /^\w*$/,
  }
}

/** Editable vs read-only, as one swappable unit. */
export function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]
}

export interface BuildExtensionsOptions extends EditorCallbacks {
  readonly schema?: SchemaIndex
  readonly readOnly: boolean
  readonly placeholderText?: string
  /**
   * Compartments owned by the caller.
   *
   * The schema arrives asynchronously and the connection can disappear, so both
   * the dialect and the editability must be reconfigurable *without* rebuilding
   * the view — rebuilding would throw away undo history and the selection.
   */
  readonly language: Compartment
  readonly readOnlySlot: Compartment
  /** Wraps the editor-intelligence extension so a schema refresh reconfigures it. */
  readonly extrasSlot: Compartment
  /** Completion extras, lint and hover, built from the current schema. */
  readonly extras?: Extension
  /** Configurable chords; defaults to {@link DEFAULT_SHORTCUTS}. */
  readonly shortcuts?: ShortcutSettings
  /** Wraps the chord keymap so a settings change needs no remount. */
  readonly shortcutsSlot: Compartment
}

/** Caret/selection snapshot for one editor state. */
function runTargetOf(view: EditorView): RunTarget {
  const range = view.state.selection.main
  return {
    doc: view.state.doc.toString(),
    selection: view.state.sliceDoc(range.from, range.to),
    cursor: range.head,
    from: range.from,
    to: range.to,
  }
}

/**
 * Build the configurable chord keymap.
 *
 * Exported so the caller can reconfigure a compartment: the handlers close over
 * `callbacks`, which the React adapter implements with refs, so a rebuilt keymap
 * always reaches the current props.
 *
 * Precedence: the action chords get `Prec.high`, which puts them ahead of the
 * plain copy of the library keymaps (`completionKeymap` … `defaultKeymap`) in
 * the last keymap of `buildExtensions`. A handler that returns false therefore
 * falls through to those — `acceptCompletion` with no popup open lets Enter
 * insert a newline and Tab indent. The autocomplete extension's own
 * `Prec.highest` copy still handles Enter/Tab while a popup is open, so the
 * default accept behaviour cannot be broken by a bad rebinding. The cancel chord
 * stays a normal keymap after the library keymaps, so Escape still closes a
 * search panel or a completion popup first.
 *
 * @param shortcuts - Current user settings.
 * @param callbacks - Editor callbacks the chords invoke.
 */
export function shortcutKeymap(shortcuts: ShortcutSettings, callbacks: EditorCallbacks): Extension {
  const handlers: Readonly<Record<(typeof KEYBOUND_SHORTCUT_ACTIONS)[number], (view: EditorView) => boolean>> = {
    run: view => {
      callbacks.onRun(runTargetOf(view))
      return true
    },
    runAll: view => {
      callbacks.onRunAll(runTargetOf(view))
      return true
    },
    rerun: () => {
      callbacks.onRerun()
      return true
    },
    explain: view => {
      callbacks.onExplain(runTargetOf(view))
      return true
    },
    history: () => {
      callbacks.onHistory()
      return true
    },
    format: view => {
      callbacks.onFormat(runTargetOf(view))
      return true
    },
    expandStar: view => {
      callbacks.onExpandStar(runTargetOf(view))
      return true
    },
    complete: view => {
      startCompletion(view)
      return true
    },
    // `acceptCompletion` returns false when no popup is open: returning that
    // straight through lets Enter fall through to the editor's newline binding
    // (and Tab to its indent binding) instead of being swallowed.
    acceptCompletion: view => acceptCompletion(view),
  }
  const actionBindings: KeyBinding[] = []
  for (const action of KEYBOUND_SHORTCUT_ACTIONS) {
    for (const key of keySpecs(shortcuts[action])) actionBindings.push({ key, run: handlers[action] })
  }
  const cancelBindings: KeyBinding[] = keySpecs(shortcuts.cancel).map(key => ({
    key,
    run: (): boolean => {
      callbacks.onCancel()
      return true
    },
  }))
  return [Prec.high(keymap.of(actionBindings)), keymap.of(cancelBindings)]
}

/**
 * Build the extension list.
 *
 * Order matters for key bindings: CodeMirror tries handlers in the order they
 * appear, so the completion popup gets `Escape` first and only an unhandled one
 * reaches "cancel the running statement".
 */
export function buildExtensions(options: BuildExtensionsOptions): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    // Column alignment: drag with Alt held for a rectangular selection (and a
    // crosshair cursor as the "hold Alt" hint). CodeMirror ships both; no custom
    // multi-cursor bookkeeping is needed.
    rectangularSelection(),
    crosshairCursor(),
    // A 300–500px right sidebar cannot show long lines; wrapping beats
    // horizontal scrolling for reading a statement (docs/03 §6).
    EditorView.lineWrapping,
    history(),
    foldGutter({ openText: '▾', closedText: '▸' }),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true, maxRenderedOptions: 40 }),
    search({ top: true }),
    highlightSelectionMatches(),
    options.language.of(sqlExtension(options.schema)),
    EditorState.languageData.of(() => [{ autocomplete: templateCompletion }]),
    syntaxHighlighting(sqlHighlightStyle),
    sqlEditorTheme,
    errorLineField,
    EditorState.phrases.of(PHRASES),
    placeholder(options.placeholderText ?? "SELECT * FROM dwd_order WHERE dt = '2026-10-01'"),
    EditorView.updateListener.of(update => {
      if (update.docChanged) options.onChange(update.state.doc.toString())
      if (update.docChanged || update.selectionSet) {
        options.onCursor?.(cursorInfoOf(update.state))
        options.onAim?.(aimOf(update.state))
      }
    }),
    options.readOnlySlot.of(readOnlyExtension(options.readOnly)),
    options.extrasSlot.of(options.extras ?? []),
    // The user-editable chords; a single compartment so the settings panel can
    // swap them in place without dropping undo history.
    options.shortcutsSlot.of(shortcutKeymap(options.shortcuts ?? DEFAULT_SHORTCUTS, options)),
    keymap.of([
      ...completionKeymap,
      ...searchKeymap,
      ...foldKeymap,
      ...historyKeymap,
      ...closeBracketsKeymap,
      indentWithTab,
      { key: 'Mod-/', run: toggleComment },
      ...defaultKeymap,
    ]),
  ]
}

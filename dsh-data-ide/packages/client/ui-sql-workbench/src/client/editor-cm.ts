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
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
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
import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'

import type { SchemaIndex } from './completion.ts'
import { keywordBoost, matchingTemplates } from './completion-rank.ts'

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
})

export interface EditorCallbacks {
  readonly onChange: (doc: string) => void
  /** `Ctrl/Cmd+Enter`, or the toolbar button. */
  readonly onRun: () => void
  /** `Escape` when no completion popup is open. */
  readonly onCancel: () => void
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
}

/**
 * Build the extension list.
 *
 * Order matters for key bindings: CodeMirror tries handlers in the order they
 * appear, so the completion popup gets `Escape` first and only an unhandled one
 * reaches "cancel the running statement".
 */
export function buildExtensions(options: BuildExtensionsOptions): Extension[] {
  const run = (): boolean => {
    options.onRun()
    return true
  }
  // `Mod-` is platform-dependent (Ctrl off macOS, Cmd on it). Binding all three
  // keeps the documented "Ctrl/Cmd+Enter" true on every host, and matches what
  // the textarea editor did.
  const runKey = Prec.high(keymap.of([
    { key: 'Mod-Enter', run },
    { key: 'Ctrl-Enter', run },
    { key: 'Cmd-Enter', run },
  ]))
  const cancelKey = keymap.of([{ key: 'Escape', run: () => {
    options.onCancel()
    return true
  } }])

  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
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
    EditorState.phrases.of(PHRASES),
    placeholder(options.placeholderText ?? "SELECT * FROM dwd_order WHERE dt = '2026-10-01'"),
    EditorView.updateListener.of(update => {
      if (update.docChanged) options.onChange(update.state.doc.toString())
    }),
    options.readOnlySlot.of(readOnlyExtension(options.readOnly)),
    // `Mod-Enter` first: it must win even while a completion popup is open.
    runKey,
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
    cancelKey,
  ]
}

/**
 * Test helper for the CodeMirror-backed editor.
 *
 * The previous editor was a `<textarea>`, so specs could set `.value` and fire
 * an `input` event. CodeMirror keeps its document in a state object, so the way
 * in is `EditorView.findFromDOM(dom)` — the same hook the library offers for
 * exactly this purpose.
 */

import { EditorView } from '@codemirror/view'

/** The live view inside the panel, or a clear failure if it never mounted. */
export function editorView(container: HTMLElement): EditorView {
  const host = container.querySelector('[data-sql-editor] .cm-editor')
  if (host === null) throw new Error('editor not mounted')
  const view = EditorView.findFromDOM(host as HTMLElement)
  if (view === null) throw new Error('no EditorView for the mounted editor')
  return view
}

/** Replace the whole document, the way typing would. */
export function setSql(container: HTMLElement, text: string): void {
  const view = editorView(container)
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
}

/** Current document text. */
export function readSql(container: HTMLElement): string {
  return editorView(container).state.doc.toString()
}

/** Select a range, so "run the selection" can be exercised. */
export function selectSql(container: HTMLElement, from: number, to: number): void {
  editorView(container).dispatch({ selection: { anchor: from, head: to } })
}

/** The contenteditable CodeMirror types into; key events must land here. */
export function contentDom(container: HTMLElement): HTMLElement {
  const node = container.querySelector('[data-sql-editor] .cm-content')
  if (node === null) throw new Error('editor content not mounted')
  return node as HTMLElement
}

/** Dispatch a keydown where CodeMirror's keymap listens. */
export function pressKey(container: HTMLElement, init: KeyboardEventInit): void {
  contentDom(container).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
}

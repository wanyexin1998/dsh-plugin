import { readFileSync, writeFileSync } from 'node:fs'

// ScriptResults: core.ts lives two levels up
let p = 'src/client/components/ScriptResults.tsx'
let t = readFileSync(p, 'utf8')
t = t.replace("from '../execute/core.ts'", "from '../../execute/core.ts'")
writeFileSync(p, t)

// SqlEditor: expose the current selection
p = 'src/client/components/SqlEditor.tsx'
t = readFileSync(p, 'utf8')
t = t.replace(`export interface SqlEditorHandle {
  /** Insert text at the caret (or over the selection) and keep the caret after it. */
  insert(text: string): void
  focus(): void
}`,
`export interface SqlEditorHandle {
  /** Insert text at the caret (or over the selection) and keep the caret after it. */
  insert(text: string): void
  focus(): void
  /** Selected text, or `` when the caret is collapsed (run-selection). */
  getSelection(): string
}`)
t = t.replace(`    focus() {
      textarea.current?.focus()
    },`,
`    focus() {
      textarea.current?.focus()
    },
    getSelection() {
      const element = textarea.current
      /* v8 ignore next -- the ref exists while the editor is mounted */
      if (element === null) return ''
      return element.value.slice(element.selectionStart, element.selectionEnd)
    },`)
writeFileSync(p, t)

// Panel: refusal shape from the script union needs narrowing
p = 'src/client/components/SqlWorkbenchPanel.tsx'
t = readFileSync(p, 'utf8')
t = t.replace(`      if ('refusal' in outcome) {
        setScript({
          tabs: [{ sql, result: null, error: outcome.refusal }],
          active: 0,
          running: false,
        })
        return
      }`,
`      if ('refusal' in outcome) {
        const refusal = outcome.refusal as { readonly code: string; readonly message: string }
        setScript({
          tabs: [{ sql, result: null, error: refusal }],
          active: 0,
          running: false,
        })
        return
      }`)
t = t.replace(`      if ('refusal' in result) {
        const tabs = [...script.tabs]
        tabs[script.active] = { ...current, error: result.refusal }`,
`      if ('refusal' in result) {
        const refusal = result.refusal as { readonly code: string; readonly message: string }
        const tabs = [...script.tabs]
        tabs[script.active] = { ...current, error: refusal }`)
writeFileSync(p, t)
console.log('fixed')

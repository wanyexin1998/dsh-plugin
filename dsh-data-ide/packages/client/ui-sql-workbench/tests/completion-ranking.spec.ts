// @vitest-environment jsdom
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { currentCompletions, startCompletion } from '@codemirror/autocomplete'
import { afterEach, describe, expect, it } from 'vitest'

import { buildExtensions } from '../src/client/editor-cm.ts'
import { keywordBoost, matchingTemplates } from '../src/client/completion-rank.ts'

let view: EditorView | undefined

afterEach(() => {
  view?.destroy()
  view = undefined
  document.body.innerHTML = ''
})

/** Open the real extension stack on `doc` with the caret at the end. */
async function complete(doc: string): Promise<readonly string[]> {
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: buildExtensions({
        onChange: () => undefined,
        onRun: () => undefined,
        onRunAll: () => undefined,
        onRerun: () => undefined,
        onExplain: () => undefined,
        onHistory: () => undefined,
        onFormat: () => undefined,
        onExpandStar: () => undefined,
        onCancel: () => undefined,
        readOnly: false,
        language: new Compartment(),
        readOnlySlot: new Compartment(),
        extrasSlot: new Compartment(),
        shortcutsSlot: new Compartment(),
      }),
    }),
    parent: document.body,
  })
  startCompletion(view)
  await new Promise(resolve => setTimeout(resolve, 300))
  return currentCompletions(view.state).map(completion => completion.label)
}

describe('completion ranking', () => {
  it('puts SELECT first for a single "S" instead of SAVEPOINT/SCHEMA', async () => {
    const labels = await complete('S')

    expect(labels[0]).toBe('SELECT')
    expect(labels.slice(0, 5)).toContain('SELECT')
  })

  it('keeps the common clauses at the top for an empty prefix', async () => {
    const labels = await complete('SELECT * FROM ')

    expect(labels.slice(0, 3)).toEqual(expect.arrayContaining(['FROM', 'WHERE']))
  })

  it('offers templates once two characters are typed, ahead of keywords', async () => {
    const labels = await complete('sel')

    expect(labels[0]).toBe('sel')
    expect(labels).toContain('SELECT')
  })
})

describe('completion ranking tables', () => {
  it('boosts only the words that were listed', () => {
    expect(keywordBoost('select')).toBeGreaterThan(keywordBoost('savepoint'))
    expect(keywordBoost('SELECT')).toBeGreaterThan(0)
    expect(keywordBoost('savepoint')).toBe(0)
  })

  it('needs two characters before templates appear', () => {
    expect(matchingTemplates('s')).toHaveLength(0)
    expect(matchingTemplates('se').map(template => template.label)).toContain('sel')
    expect(matchingTemplates('zz')).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'

import { applyDiff, diffLines, diffSummary, type DiffLine } from '../src/client/sql-diff.ts'

/** Compact view of a diff for table-style assertions. */
const shape = (lines: readonly DiffLine[]): string[] => lines.map(line => `${line.type}:${line.text}`)

describe('diffLines', () => {
  it('returns no rows for two empty texts', () => {
    expect(diffLines('', '')).toEqual([])
    expect(diffSummary(diffLines('', ''))).toEqual({ added: 0, removed: 0, unchanged: 0 })
    expect(applyDiff(diffLines('', ''))).toBe('')
  })

  it('marks identical multi-line SQL as unchanged', () => {
    const sql = 'SELECT 1;\nSELECT 2;'
    expect(shape(diffLines(sql, sql))).toEqual(['same:SELECT 1;', 'same:SELECT 2;'])
    expect(diffSummary(diffLines(sql, sql))).toEqual({ added: 0, removed: 0, unchanged: 2 })
  })

  it('appends a new statement as add rows at the end', () => {
    const lines = diffLines('SELECT 1;', 'SELECT 1;\nSELECT 2;')
    expect(shape(lines)).toEqual(['same:SELECT 1;', 'add:SELECT 2;'])
    expect(diffSummary(lines)).toEqual({ added: 1, removed: 0, unchanged: 1 })
  })

  it('prepends a new statement as add rows inside the walk', () => {
    const lines = diffLines('SELECT 2;', 'SELECT 1;\nSELECT 2;')
    expect(shape(lines)).toEqual(['add:SELECT 1;', 'same:SELECT 2;'])
  })

  it('drops a removed tail statement as del rows', () => {
    const lines = diffLines('SELECT 1;\nSELECT 2;', 'SELECT 1;')
    expect(shape(lines)).toEqual(['same:SELECT 1;', 'del:SELECT 2;'])
    expect(diffSummary(lines)).toEqual({ added: 0, removed: 1, unchanged: 1 })
  })

  it('represents a replaced line as delete then add', () => {
    const lines = diffLines('a\nb', 'a\nc')
    expect(shape(lines)).toEqual(['same:a', 'del:b', 'add:c'])
    expect(diffSummary(lines)).toEqual({ added: 1, removed: 1, unchanged: 1 })
  })

  it('keeps whitespace: indentation and blank lines stay verbatim', () => {
    const lines = diffLines('SELECT\n  1', 'SELECT\n   1')
    expect(shape(lines)).toEqual(['same:SELECT', 'del:  1', 'add:   1'])
    expect(diffSummary(lines).unchanged).toBe(1)
  })

  it('round-trips a trailing newline through applyDiff', () => {
    const original = 'SELECT 1;\n'
    const proposal = 'SELECT 1;\nSELECT 2;\n'
    expect(applyDiff(diffLines(original, proposal))).toBe(proposal)
    expect(shape(diffLines(original, proposal))).toEqual(['same:SELECT 1;', 'add:SELECT 2;', 'same:'])
  })

  it('reconstructs a wholesale replacement', () => {
    const proposal = 'SELECT 2;'
    expect(applyDiff(diffLines('SELECT 1;', proposal))).toBe(proposal)
  })

  it('reconstructs only the added rows when the original is empty', () => {
    const proposal = 'a\nb'
    const lines = diffLines('', proposal)
    expect(shape(lines)).toEqual(['add:a', 'add:b'])
    expect(applyDiff(lines)).toBe(proposal)
  })

  it('reconstructs the empty text when everything is deleted', () => {
    const lines = diffLines('a\nb', '')
    expect(shape(lines)).toEqual(['del:a', 'del:b'])
    expect(applyDiff(lines)).toBe('')
  })
})

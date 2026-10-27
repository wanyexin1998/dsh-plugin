import { describe, expect, it } from 'vitest'

import { splitStatements, statementAt } from '../src/execute/split.ts'

describe('splitStatements: offsets', () => {
  it('records the trimmed start and exclusive end of each statement', () => {
    const sql = '  SELECT 1;\n  SELECT 2;'
    const statements = splitStatements(sql)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toEqual({ text: 'SELECT 1', start: 2, end: 10 })
    expect(sql.slice(statements[0]?.start, statements[0]?.end)).toBe('SELECT 1')
    expect(statements[1]).toEqual({ text: 'SELECT 2', start: 14, end: 22 })
    expect(sql.slice(statements[1]?.start, statements[1]?.end)).toBe('SELECT 2')
  })

  it('ignores semicolons inside strings and comments', () => {
    const sql = "SELECT * FROM t WHERE a = 'x;y'; -- note ; inside\nSELECT 2"
    const statements = splitStatements(sql)
    expect(statements).toHaveLength(2)
    expect(statements[0]?.text).toBe("SELECT * FROM t WHERE a = 'x;y'")
    // A leading line comment travels with the statement it precedes.
    expect(statements[1]?.text).toContain('SELECT 2')
    expect(statements[1]?.text).not.toContain("'x;y'; -- note ; inside\nSELECT 2")
  })
})

describe('statementAt', () => {
  const sql = 'SELECT 1;\n\nSELECT 2;\n-- trailing comment\nSELECT 3'

  it('returns the statement containing the caret', () => {
    expect(statementAt(sql, 3)?.text).toBe('SELECT 1')
    expect(statementAt(sql, sql.indexOf('SELECT 2') + 3)?.text).toBe('SELECT 2')
    expect(statementAt(sql, sql.length - 1)?.text).toContain('SELECT 3')
  })

  it('gives the whitespace between statements to the next one', () => {
    // Offset 9 is the blank line after statement 1's semicolon.
    expect(statementAt(sql, 9)?.text).toBe('SELECT 2')
    expect(statementAt(sql, 10)?.text).toBe('SELECT 2')
  })

  it('clamps offsets and falls back to the last statement', () => {
    expect(statementAt(sql, -100)?.text).toBe('SELECT 1')
    expect(statementAt(sql, 10_000)?.text).toContain('SELECT 3')
    // Trailing whitespace lies past the last statement's end, so the fallback wins.
    expect(statementAt('SELECT 1   ', 11)?.text).toBe('SELECT 1')
  })

  it('returns null for an empty or comment-only script', () => {
    expect(statementAt('', 0)).toBeNull()
    expect(statementAt('   ', 2)).toBeNull()
    expect(statementAt('-- just a comment', 4)).toBeNull()
  })

  it('keeps locating statements beyond the old 50-statement scan cap', () => {
    const many = Array.from({ length: 60 }, (_, index) => `SELECT ${String(index)}`).join('; ')
    const last = statementAt(many, many.length - 1)
    expect(last?.text).toBe('SELECT 59')
  })

  it('honours an explicit statement limit', () => {
    expect(splitStatements('SELECT 1; SELECT 2; SELECT 3', 2)).toHaveLength(2)
  })
})

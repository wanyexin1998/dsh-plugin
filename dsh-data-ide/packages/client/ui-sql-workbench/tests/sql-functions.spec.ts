import { describe, expect, it } from 'vitest'

import {
  SQL_FUNCTIONS,
  findSqlFunction,
  functionSnippet,
  isSqlFunction,
  matchSqlFunctions,
} from '../src/client/sql-functions.ts'

describe('SQL function catalogue', () => {
  it('covers well over the 60 functions the editor promises', () => {
    expect(SQL_FUNCTIONS.length).toBeGreaterThanOrEqual(60)
  })

  it('has unique names, and signatures that name the function', () => {
    const names = SQL_FUNCTIONS.map(fn => fn.name)
    expect(new Set(names).size).toBe(names.length)
    for (const fn of SQL_FUNCTIONS) {
      expect(fn.signature.startsWith(`${fn.name}(`)).toBe(true)
      expect(fn.signature.endsWith(')')).toBe(true)
      expect(fn.detail.length).toBeGreaterThan(0)
      expect(fn.name).toBe(fn.name.toUpperCase())
    }
  })

  it('ships the handful of functions people type every day', () => {
    const required = ['DATE_FORMAT', 'IFNULL', 'COALESCE', 'CAST', 'CONCAT', 'SUBSTR', 'ROUND', 'ROW_NUMBER', 'RANK', 'LAG']
    for (const name of required) expect(isSqlFunction(name)).toBe(true)
  })

  it('groups every row into one of the documented categories', () => {
    const categories = new Set(SQL_FUNCTIONS.map(fn => fn.category))
    expect([...categories].sort()).toEqual([
      'aggregate', 'conditional', 'conversion', 'date', 'json', 'numeric', 'string', 'system', 'window',
    ])
  })
})

describe('function lookup', () => {
  it('finds a function case-insensitively and reports nothing for other words', () => {
    expect(findSqlFunction('date_format')?.name).toBe('DATE_FORMAT')
    expect(findSqlFunction('DATE_FORMAT')?.category).toBe('date')
    expect(findSqlFunction('dwd_order')).toBeUndefined()
    expect(isSqlFunction('dwd_order')).toBe(false)
    expect(isSqlFunction('now')).toBe(true)
  })

  it('prefix-searches the catalogue case-insensitively', () => {
    const matches = matchSqlFunctions('date').map(fn => fn.name)
    expect(matches).toContain('DATE_FORMAT')
    expect(matches).toContain('DATEDIFF')
    expect(matchSqlFunctions('DATE')).toEqual(matchSqlFunctions('date'))
    expect(matchSqlFunctions('zzzz')).toEqual([])
  })

  it('returns the whole catalogue for an empty prefix, capped by the limit', () => {
    expect(matchSqlFunctions('')).toHaveLength(SQL_FUNCTIONS.length)
    expect(matchSqlFunctions('', 2)).toHaveLength(2)
    expect(matchSqlFunctions('date', 1)).toHaveLength(1)
    expect(matchSqlFunctions('date', 0)).toHaveLength(0)
  })
})

describe('function snippets', () => {
  it('turns each argument of the signature into a named tab stop', () => {
    expect(functionSnippet(findFunction('ROUND'))).toBe('ROUND(${x}, ${d})')
    expect(functionSnippet(findFunction('CONCAT'))).toBe('CONCAT(${str1}, ${str2})')
  })

  it('leaves a no-argument call alone', () => {
    expect(functionSnippet(findFunction('NOW'))).toBe('NOW()')
  })

  it('prefers an explicit snippet when the signature cannot be split safely', () => {
    expect(functionSnippet(findFunction('CAST'))).toBe('CAST(${x} AS ${type})')
  })

  it('falls back to the bare signature when there is no argument list to split', () => {
    // Defensive arm: the catalogue always writes signatures with parentheses, but
    // a future entry (or an extension point) may not.
    expect(functionSnippet({ name: 'MYSTERY', signature: 'MYSTERY', category: 'system', detail: '无参数' }))
      .toBe('MYSTERY')
  })

  /** Narrow lookup used only by this spec, so a missing entry fails loudly. */
  function findFunction(name: string) {
    const fn = findSqlFunction(name)
    if (fn === undefined) throw new Error(`missing catalogue entry ${name}`)
    return fn
  }
})

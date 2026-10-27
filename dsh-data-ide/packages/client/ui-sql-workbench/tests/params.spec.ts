import { describe, expect, it } from 'vitest'

import { findSqlParams, paramLiteral, paramNames, substituteSqlParams } from '../src/client/params.ts'

describe('findSqlParams', () => {
  it('finds named placeholders outside literals and comments', () => {
    const sql = "SELECT * FROM t WHERE id = :id AND name = :name AND d = '12:30' -- :ignored\n/* :also */ AND `a:b` = 1"
    expect(findSqlParams(sql).map(param => param.name)).toEqual(['id', 'name'])
  })

  it('skips casts and identifier-adjacent colons', () => {
    expect(findSqlParams('SELECT 1::int, a:b, :ok').map(param => param.name)).toEqual(['ok'])
  })

  it('rejects a leading digit and tolerates doubled quotes', () => {
    expect(findSqlParams('SELECT :1 FROM t')).toEqual([])
    expect(findSqlParams("SELECT ') :x' , :y").map(param => param.name)).toEqual(['y'])
  })

  it('does not treat a colon after an identifier char as a parameter', () => {
    expect(findSqlParams('SELECT a:b FROM t')).toEqual([])
  })

  it('skips doubled quotes and unterminated comments', () => {
    expect(findSqlParams("SELECT 'it''s :x', :y").map(param => param.name)).toEqual(['y'])
    expect(findSqlParams('SELECT /* :x ')).toEqual([])
    expect(findSqlParams('SELECT -- :x')).toEqual([])
  })
})

describe('paramNames', () => {
  it('dedupes in first-appearance order', () => {
    expect(paramNames(findSqlParams('SELECT :a, :b, :a'))).toEqual(['a', 'b'])
  })
})

describe('paramLiteral', () => {
  it('keeps numbers raw, maps empty/NULL to NULL and quotes the rest', () => {
    expect(paramLiteral('42')).toBe('42')
    expect(paramLiteral('-1.5e3')).toBe('-1.5e3')
    expect(paramLiteral('  ')).toBe('NULL')
    expect(paramLiteral('null')).toBe('NULL')
    expect(paramLiteral("O'Hara")).toBe("'O''Hara'")
    expect(paramLiteral('a\\b')).toBe("'a\\\\b'")
    expect(paramLiteral('12:30')).toBe("'12:30'")
  })
})

describe('substituteSqlParams', () => {
  it('replaces every occurrence and leaves missing names intact', () => {
    const sql = 'SELECT * FROM t WHERE a = :a AND b = :b'
    expect(substituteSqlParams(sql, { a: '1', b: 'x' })).toBe("SELECT * FROM t WHERE a = 1 AND b = 'x'")
    expect(substituteSqlParams(sql, { a: '1' })).toBe('SELECT * FROM t WHERE a = 1 AND b = :b')
  })

  it('returns the text unchanged when there is nothing to fill', () => {
    expect(substituteSqlParams('SELECT 1', {})).toBe('SELECT 1')
  })
})

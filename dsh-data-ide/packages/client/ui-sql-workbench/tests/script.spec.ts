import { describe, expect, it, vi } from 'vitest'

import { MAX_SCRIPT_STATEMENTS, isScript, splitStatements } from '../src/execute/split.ts'
import { executeScript } from '../src/execute/script.ts'
import type { ExecutionDeps, QueryExecutor } from '../src/execute/core.ts'
import type { RuntimeSpecDocument } from '../src/host/runtime-specs.ts'

const texts = (sql: string) => splitStatements(sql).map(statement => statement.text)

describe('splitStatements', () => {
  it('splits on top-level semicolons', () => {
    expect(texts('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('keeps a single statement intact', () => {
    expect(texts('SELECT 1')).toEqual(['SELECT 1'])
  })

  it('ignores separators inside strings, backticks and comments', () => {
    expect(texts("SELECT 'a;b'; SELECT 2")).toEqual(["SELECT 'a;b'", 'SELECT 2'])
    expect(texts('SELECT `a;b` FROM t; SELECT 2')).toEqual(['SELECT `a;b` FROM t', 'SELECT 2'])
    expect(texts('SELECT 1 -- a;b\n; SELECT 2')).toEqual(['SELECT 1 -- a;b', 'SELECT 2'])
    expect(texts('SELECT 1 /* a;b */; SELECT 2')).toEqual(['SELECT 1 /* a;b */', 'SELECT 2'])
  })

  it('handles doubled quotes and backslash escapes', () => {
    expect(texts("SELECT 'O''Brien;x'; SELECT 2")).toEqual(["SELECT 'O''Brien;x'", 'SELECT 2'])
    expect(texts("SELECT 'a\\';b'")).toEqual(["SELECT 'a\\';b'"])
  })

  it('drops empty statements and records the real offset', () => {
    const statements = splitStatements('  SELECT 1 ;;  SELECT 2  ;')
    expect(statements.map(statement => statement.text)).toEqual(['SELECT 1', 'SELECT 2'])
    expect(statements[1]?.start).toBe('  SELECT 1 ;;  '.length)
  })

  it('returns nothing for whitespace-only input', () => {
    expect(splitStatements('   \n\t ')).toEqual([])
  })

  it('caps the statement count', () => {
    const many = Array.from({ length: MAX_SCRIPT_STATEMENTS + 5 }, () => 'SELECT 1').join(';')
    expect(splitStatements(many)).toHaveLength(MAX_SCRIPT_STATEMENTS)
  })

  it('treats an unterminated quote or comment as running to the end', () => {
    expect(texts("SELECT 'oops;")).toEqual(["SELECT 'oops;"])
    expect(texts('SELECT 1 /* never;')).toEqual(['SELECT 1 /* never;'])
  })

  it('reports whether a script has more than one statement', () => {
    expect(isScript('SELECT 1')).toBe(false)
    expect(isScript('SELECT 1; SELECT 2')).toBe(true)
  })
})

const document: RuntimeSpecDocument = {
  schemaVersion: 1,
  generatedAt: '2026-10-19T00:00:00.000Z',
  connections: {
    'conn-1': {
      name: 'doris',
      dbms: 'doris',
      host: 'h',
      port: 9030,
      username: 'u',
      password: 'p',
      driverProperties: {},
      writeEnabled: false,
    },
  },
}

/** Executor that answers each statement with one row carrying its text. */
function depsFor(fail: RegExp | undefined = undefined) {
  const seen: string[] = []
  const executor: QueryExecutor = {
    query: vi.fn(async (_spec, sql) => {
      seen.push(sql)
      if (fail !== undefined && fail.test(sql)) throw new Error('boom')
      return { fields: [{ name: 'v', typeName: 'INT' }], rows: [[1]] }
    }),
    cancel: vi.fn(async () => undefined),
  }
  const deps: ExecutionDeps = {
    specs: async () => document,
    executor,
    registry: { next: () => 'st-1', forget: () => {}, register: () => {}, get: () => undefined } as unknown as ExecutionDeps['registry'],
  }
  return { deps, seen }
}

describe('executeScript', () => {
  it('runs statements in order and reports each result', async () => {
    const { deps } = depsFor()

    const outcome = await executeScript(deps, { connId: 'conn-1', sql: 'SELECT 1; SELECT 2' })

    expect('refusal' in outcome).toBe(false)
    if ('refusal' in outcome) return
    expect(outcome.statements).toHaveLength(2)
    expect(outcome.statements.map(statement => statement.index)).toEqual([0, 1])
    expect(outcome.statements.every(statement => statement.ok)).toBe(true)
    expect(outcome.stopped).toBeUndefined()
  })

  it('stops at the first failing statement and keeps what ran', async () => {
    const { deps } = depsFor(/SELECT 2/)

    const outcome = await executeScript(deps, { connId: 'conn-1', sql: 'SELECT 1; SELECT 2; SELECT 3' })

    expect('refusal' in outcome).toBe(false)
    if ('refusal' in outcome) return
    expect(outcome.statements).toHaveLength(2)
    expect(outcome.statements[1]).toMatchObject({ ok: false })
    expect(outcome.stopped).toBe(true)
  })

  it('refuses an empty script', async () => {
    const { deps } = depsFor()

    const outcome = await executeScript(deps, { connId: 'conn-1', sql: '   ' })

    expect('refusal' in outcome && outcome.refusal.code).toBe('EMPTY_SQL')
  })

  it('reports the write guard as a failed statement', async () => {
    const { deps } = depsFor()

    const outcome = await executeScript(deps, { connId: 'conn-1', sql: 'DELETE FROM t' })

    expect('refusal' in outcome).toBe(false)
    if ('refusal' in outcome) return
    expect(outcome.statements[0]).toMatchObject({ ok: false })
  })

  it('passes the page size through to each statement', async () => {
    const { deps, seen } = depsFor()

    await executeScript(deps, { connId: 'conn-1', sql: 'SELECT 1; SELECT 2', pageSize: 100 })

    expect(seen.some(sql => sql.includes('LIMIT 101'))).toBe(true)
  })
})

describe('splitStatements: end-of-input comment', () => {
  it('skips a trailing comment that has no newline', () => {
    expect(texts('SELECT 1 -- trailing')).toEqual(['SELECT 1 -- trailing'])
    expect(texts('SELECT 1 # trailing')).toEqual(['SELECT 1 # trailing'])
  })
})

describe('executeScript: non-Error failures', () => {
  it('stringifies a thrown non-Error', async () => {
    const executor: QueryExecutor = {
      query: vi.fn(async () => {
        throw 'plain string failure'
      }),
      cancel: vi.fn(async () => undefined),
    }
    const deps: ExecutionDeps = {
      specs: async () => document,
      executor,
      registry: { next: () => 'st', forget: () => {}, register: () => {}, get: () => undefined } as unknown as ExecutionDeps['registry'],
    }

    const outcome = await executeScript(deps, { connId: 'conn-1', sql: 'SELECT 1' })

    expect('refusal' in outcome).toBe(false)
    if ('refusal' in outcome) return
    expect(outcome.statements[0]).toMatchObject({ ok: false, error: { message: 'plain string failure' } })
  })
})

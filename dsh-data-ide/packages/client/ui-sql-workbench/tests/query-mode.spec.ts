import { describe, expect, it, vi } from 'vitest'

import { INITIAL_QUERY, goPage, run, setMode, setPageSize, type QueryState } from '../src/client/state/query.ts'
import type { WorkbenchApi } from '../src/client/api.ts'
import type { ExecuteResponse } from '../src/execute/core.ts'

const connId = 'c1'

const page: ExecuteResponse = {
  columns: [{ name: 'id', typeName: 'LONG' }],
  rows: [[1]],
  total: null,
  hasNextPage: false,
  offset: 0,
  durationMs: 4,
  statementId: 'ui-1',
}

function apiDouble(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  return {
    execute: vi.fn(async () => ({ ok: true as const, ...page })),
    fetchPage: vi.fn(async () => ({ ok: true as const, ...page })),
    ...overrides,
  } as unknown as WorkbenchApi
}

const state = (patch: Partial<QueryState> = {}): QueryState => ({ ...INITIAL_QUERY, sql: 'SELECT 1', ...patch })

describe('query mode', () => {
  it('starts in direct mode and sends it with the request', async () => {
    expect(INITIAL_QUERY.mode).toBe('direct')
    const api = apiDouble()
    await run(api, state(), connId)

    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 'direct', sql: 'SELECT 1' }))
  })

  it('runs the override SQL (statement under the caret) while keeping the editor text', async () => {
    const api = apiDouble()
    const result = await run(api, state({ sql: 'SELECT 1; SELECT 2' }), connId, undefined, 'SELECT 2')

    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SELECT 2' }))
    expect(result.sql).toBe('SELECT 1; SELECT 2')
  })

  it('switches to paged on explicit mode and page-size changes', () => {
    expect(setMode(state(), 'paged').mode).toBe('paged')
    expect(setPageSize(state(), 1000)).toMatchObject({ mode: 'paged', pageSize: 1000 })
  })

  it('forces the paged wrapper for a page turn from a direct result', async () => {
    const api = apiDouble()
    const next = await goPage(api, state({ result: page }), connId, 100)

    expect(api.fetchPage).toHaveBeenCalledWith(expect.objectContaining({ mode: 'paged', offset: 100 }))
    expect(next.mode).toBe('paged')
  })
})

describe('error line mapping', () => {
  const refusal = { ok: false as const, error: { code: 'SQL_SYNTAX', message: 'INTERNAL: errCode = 2, detailMessage = Syntax error in line 3' } }

  it('maps a direct SELECT error through the outer wrapper offset', async () => {
    const api = apiDouble({ execute: vi.fn(async () => refusal) })
    const next = await run(api, state({ sql: 'SELECT 1\nSELECT 2' }), connId)
    expect(next.error?.line).toBe(2)
  })

  it('keeps the raw line for a metadata statement', async () => {
    const api = apiDouble({ execute: vi.fn(async () => refusal) })
    const next = await run(api, state({ sql: 'SHOW TABLES' }), connId)
    expect(next.error?.line).toBe(3)
  })

  it('maps paged errors through the wrapper too', async () => {
    const api = apiDouble({ execute: vi.fn(async () => refusal) })
    const next = await run(api, state({ sql: 'SELECT 1', mode: 'paged' }), connId)
    expect(next.error?.line).toBe(2)
  })

  it('leaves the line absent when the driver gave no position', async () => {
    const api = apiDouble({ execute: vi.fn(async () => ({ ok: false as const, error: { code: 'X', message: '连接已断开' } })) })
    const next = await run(api, state(), connId)
    expect(next.error?.line).toBeUndefined()
  })

  it('maps a thrown transport failure and keeps the readable message', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => {
        throw new Error('INTERNAL: errCode = 2, detailMessage = Syntax error in line 4')
      }),
    })
    const next = await run(api, state({ sql: 'SELECT 1' }), connId)
    expect(next.error?.code).toBe('UNKNOWN')
    expect(next.error?.line).toBe(3)
    expect(next.error?.message).toContain('语法错误')
  })

  it('keeps the raw line for a thrown metadata error', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => {
        throw new Error('Syntax error in line 4')
      }),
    })
    const next = await run(api, state({ sql: 'SHOW TABLES' }), connId)
    expect(next.error?.line).toBe(4)
  })

  it('uses the executed override SQL for the line offset', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'SQL_SYNTAX', message: 'Syntax error in line 3' },
      })),
    })
    const next = await run(api, state({ sql: 'SELECT 1' }), connId, undefined, 'SHOW TABLES')
    // A metadata statement has no wrapper, so the driver line is the user's line.
    expect(next.error?.line).toBe(3)
  })
})

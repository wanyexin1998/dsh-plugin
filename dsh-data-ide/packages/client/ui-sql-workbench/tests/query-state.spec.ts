import { describe, expect, it, vi } from 'vitest'

import type { WorkbenchApi } from '../src/client/api.ts'
import type { ExecuteResponse } from '../src/execute/core.ts'
import {
  DEFAULT_PAGE_SIZE,
  INITIAL_QUERY,
  type QueryState,
  cancel,
  goPage,
  nextSort,
  nextStatementId,
  run,
  setPageSize,
  setSql,
  sortBy,
} from '../src/client/state/query.ts'

const connId = 'ds-f02da6e0'

/** One page as the engine returns it. */
function page(overrides: Partial<ExecuteResponse> = {}): ExecuteResponse {
  return {
    columns: [{ name: 'a', typeName: 'LONG' }],
    rows: [[1]],
    total: 3,
    hasNextPage: false,
    offset: 0,
    durationMs: 12,
    statementId: 'stmt-1',
    ...overrides,
  }
}

function fakeApi(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  return {
    list: vi.fn(async () => []),
    active: vi.fn(async () => connId),
    setActive: vi.fn(async () => undefined),
    save: vi.fn(),
    remove: vi.fn(async () => true),
    test: vi.fn(),
    execute: vi.fn(async () => ({ ok: true as const, ...page() })),
    fetchPage: vi.fn(async () => ({ ok: true as const, ...page({ offset: 500, total: null }) })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => ({ tables: [], fetchedAt: '1970-01-01T00:00:00.000Z', truncated: false, source: 'information_schema' as const })),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
    ...overrides,
  } as unknown as WorkbenchApi
}

const editing: QueryState = { ...INITIAL_QUERY, sql: 'SELECT a FROM t' }

describe('query state: editing', () => {
  it('keeps the last result while the text changes', () => {
    const state = setSql({ ...INITIAL_QUERY, result: page() }, 'SELECT 2')

    expect(state.sql).toBe('SELECT 2')
    expect(state.result).not.toBeNull()
  })

  it('changes the page size without refetching', () => {
    expect(setPageSize(INITIAL_QUERY, 1000).pageSize).toBe(1000)
    expect(DEFAULT_PAGE_SIZE).toBe(500)
  })

  it('mints a fresh statement id per call', () => {
    expect(nextStatementId()).not.toBe(nextStatementId())
  })
})

describe('query state: running', () => {
  it('stores the page, the total and the id used', async () => {
    const api = fakeApi()
    const state = await run(api, editing, connId)

    expect(state.status).toBe('done')
    expect(state.result).toMatchObject({ rows: [[1]] })
    expect(state.total).toBe(3)
    // Nothing is left in flight, so cancel has no target afterwards.
    expect(state.statementId).toBeNull()
    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ connId, sql: 'SELECT a FROM t', pageSize: 500 }))
  })

  it('publishes the running state before the host answers', async () => {
    const api = fakeApi()
    const seen: QueryState[] = []

    await run(api, editing, connId, running => seen.push(running))

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ status: 'running' })
    expect(seen[0]?.statementId).not.toBeNull()
  })

  it('sends the active sort and page size', async () => {
    const api = fakeApi()
    const state = { ...editing, sort: { column: 'a', direction: 'DESC' as const }, pageSize: 100 }

    await run(api, state, connId)

    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ sort: { column: 'a', direction: 'DESC' }, pageSize: 100 }))
    expect(api.execute).toHaveBeenCalledWith(expect.not.objectContaining({ offset: expect.anything() }))
  })

  it('surfaces a refusal and drops the stale page', async () => {
    const api = fakeApi({
      execute: vi.fn(async () => ({ ok: false as const, error: { code: 'WRITE_NOT_ALLOWED', message: '只读' } })),
    })

    const state = await run(api, { ...editing, result: page() }, connId)

    expect(state).toMatchObject({ status: 'error', result: null, total: null, error: { code: 'WRITE_NOT_ALLOWED' } })
  })

  it('turns a thrown host error into a readable failure', async () => {
    const api = fakeApi({ execute: vi.fn(async () => Promise.reject(new Error('host down'))) })

    expect(await run(api, editing, connId)).toMatchObject({ status: 'error', error: { code: 'UNKNOWN', message: 'host down' } })
  })

  it('stringifies a non-Error rejection', async () => {
    const api = fakeApi({ execute: vi.fn(async () => Promise.reject('nope')) })

    expect(await run(api, editing, connId)).toMatchObject({ status: 'error', error: { message: 'nope' } })
  })
})

describe('query state: paging', () => {
  it('does nothing without a first page', async () => {
    const api = fakeApi()

    expect(await goPage(api, editing, connId, 500)).toBe(editing)
    expect(api.fetchPage).not.toHaveBeenCalled()
  })

  it('refuses a negative offset', async () => {
    const api = fakeApi()

    expect(await goPage(api, { ...editing, result: page() }, connId, -1)).toMatchObject({ result: page() })
    expect(api.fetchPage).not.toHaveBeenCalled()
  })

  it('keeps the cached total across pages', async () => {
    const api = fakeApi()
    const state = await goPage(api, { ...editing, result: page(), total: 103572 }, connId, 500)

    expect(api.fetchPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 500, sql: 'SELECT a FROM t' }))
    expect(state).toMatchObject({ status: 'done', total: 103572, result: { offset: 500 } })
  })

  it('keeps the previous page visible when the next one fails', async () => {
    const api = fakeApi({
      fetchPage: vi.fn(async () => ({ ok: false as const, error: { code: 'CONN_NOT_FOUND', message: '没了' } })),
    })

    const state = await goPage(api, { ...editing, result: page() }, connId, 500)

    expect(state).toMatchObject({ status: 'error', result: { offset: 0 }, error: { code: 'CONN_NOT_FOUND' } })
  })

  it('turns a thrown fetch into a failure', async () => {
    const api = fakeApi({ fetchPage: vi.fn(async () => Promise.reject(new Error('timeout'))) })

    expect(await goPage(api, { ...editing, result: page() }, connId, 500)).toMatchObject({
      status: 'error',
      error: { message: 'timeout' },
    })
  })
})

describe('query state: sorting', () => {
  it('cycles none → ASC → DESC → none', () => {
    expect(nextSort(null, 'a')).toEqual({ column: 'a', direction: 'ASC' })
    expect(nextSort({ column: 'a', direction: 'ASC' }, 'a')).toEqual({ column: 'a', direction: 'DESC' })
    expect(nextSort({ column: 'a', direction: 'DESC' }, 'a')).toBeNull()
  })

  it('restarts at a different column', () => {
    expect(nextSort({ column: 'a', direction: 'DESC' }, 'b')).toEqual({ column: 'b', direction: 'ASC' })
  })

  it('re-fetches page one under the new ordering', async () => {
    const api = fakeApi()
    const seen: QueryState[] = []

    const state = await sortBy(api, { ...editing, result: page(), total: 900 }, connId, 'created_at', running => seen.push(running))

    expect(api.fetchPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, sort: { column: 'created_at', direction: 'ASC' } }))
    expect(state.sort).toEqual({ column: 'created_at', direction: 'ASC' })
    expect(seen[0]).toMatchObject({ status: 'running' })
  })

  it('does not page when there is no result to page through', async () => {
    const api = fakeApi()
    const seen: QueryState[] = []

    const state = await sortBy(api, editing, connId, 'a', running => seen.push(running))

    // The ordering is remembered but nothing is fetched or published.
    expect(state.sort).toEqual({ column: 'a', direction: 'ASC' })
    expect(api.fetchPage).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
  })
})

describe('query state: cancelling', () => {
  it('does nothing when no statement is in flight', async () => {
    const api = fakeApi()

    expect(await cancel(api, INITIAL_QUERY)).toBe(INITIAL_QUERY)
    expect(api.cancel).not.toHaveBeenCalled()
  })

  it('aborts the statement and says so', async () => {
    const api = fakeApi()
    const state = await cancel(api, { ...editing, status: 'running', statementId: 'ui-9' })

    expect(api.cancel).toHaveBeenCalledWith('ui-9')
    expect(state).toMatchObject({ status: 'error', statementId: null, error: { code: 'CANCELLED' } })
  })

  it('reports a cancel that the host refused', async () => {
    const api = fakeApi({ cancel: vi.fn(async () => Promise.reject(new Error('socket gone'))) })

    const state = await cancel(api, { ...editing, statementId: 'ui-9' })

    expect(state).toMatchObject({ status: 'error', statementId: 'ui-9', error: { message: 'socket gone' } })
  })
})

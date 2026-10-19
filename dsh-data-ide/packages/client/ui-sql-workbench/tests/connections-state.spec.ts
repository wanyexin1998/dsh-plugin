import { describe, expect, it, vi } from 'vitest'

import { createDataSource } from '../src/datasource/model.ts'
import { type ConnectionDraft, type TestResult, type WorkbenchApi } from '../src/client/api.ts'
import {
  cancelEdit,
  draftFor,
  load,
  remove,
  save,
  select,
  startCreate,
  startEdit,
  test,
  toDraft,
  unavailable,
} from '../src/client/state/connections.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const doris = createDataSource({ id: connId, name: 'doris.shcell.com', dbms: 'doris', host: 'doris.shcell.com', username: 'wanyexin' })

/** Host service double with scripted results. */
function fakeApi(overrides: Partial<WorkbenchApi> = {}) {
  return {
    list: vi.fn(async () => [doris]),
    active: vi.fn(async () => connId),
    setActive: vi.fn(async () => undefined),
    save: vi.fn(async (draft: ConnectionDraft) => ({ ...createDataSource({ id: connId, name: draft.name, dbms: draft.dbms, host: draft.host, port: draft.port, username: draft.username }), ...draft })),
    remove: vi.fn(async () => true),
    test: vi.fn(async (): Promise<TestResult> => ({ state: 'YES', durationMs: 120 })),
    execute: vi.fn(async () => ({ ok: false as const, error: { code: 'NOT_STUBBED', message: 'execute' } })),
    fetchPage: vi.fn(async () => ({ ok: false as const, error: { code: 'NOT_STUBBED', message: 'fetchPage' } })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => ({ tables: [], fetchedAt: '1970-01-01T00:00:00.000Z', truncated: false, source: 'information_schema' as const })),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
    ...overrides,
  } satisfies WorkbenchApi & Record<string, unknown>
}

describe('panel state machine', () => {
  it('loads connections and the active selection', async () => {
    const state = await load(fakeApi())

    expect(state.phase).toBe('ready')
    expect(state.connections).toHaveLength(1)
    expect(state.activeId).toBe(connId)
  })

  it('reports a load failure instead of throwing', async () => {
    const state = await load(fakeApi({ list: async () => Promise.reject(new Error('boom')) }))

    expect(state.phase).toBe('error')
    expect(state.message).toBe('boom')
  })

  it('explains a missing host service', () => {
    expect(unavailable('no host')).toMatchObject({ phase: 'unavailable', message: 'no host' })
  })

  it('persists the selection', async () => {
    const api = fakeApi()
    const state = await load(api)

    const next = await select(api, state, connId)

    expect(api.setActive).toHaveBeenCalledWith(connId)
    expect(next.activeId).toBe(connId)
  })

  it('records a passing verdict', async () => {
    const api = fakeApi()
    const state = await load(api)

    const next = await test(api, state, connId)

    expect(next.testingId).toBeNull()
    expect(next.verdicts[connId]).toMatchObject({ state: 'YES' })
  })

  it('turns a thrown probe into an UNSURE verdict with a reason', async () => {
    const api = fakeApi({ test: async () => Promise.reject(new Error('probe exploded')) })
    const state = await load(api)

    const next = await test(api, state, connId)

    expect(next.verdicts[connId]).toMatchObject({ state: 'UNSURE', error: { message: 'probe exploded' } })
  })

  it('keeps a failed verdict that the host already cached', async () => {
    const api = fakeApi({ test: async () => ({ state: 'NO', durationMs: 900, error: { code: 'AUTH_FAILED', message: 'Access denied', hint: '检查密码' } }) })
    const state = await load(api)

    expect((await test(api, state, connId)).verdicts[connId]).toMatchObject({ state: 'NO' })
  })

  it('opens a blank draft and an editable copy', async () => {
    const state = await load(fakeApi())

    expect(startCreate(state).editing).toMatchObject({ name: '', dbms: 'doris', port: 9030 })
    expect(startEdit(state, connId).editing).toMatchObject({ name: 'doris.shcell.com', host: 'doris.shcell.com' })
    expect(startEdit(state, 'missing').editing).toBeNull()
  })

  it('closes the editor without saving', async () => {
    const state = startCreate(await load(fakeApi()))

    expect(cancelEdit(state).editing).toBeNull()
  })

  it('refuses an incomplete draft before touching the host', async () => {
    const api = fakeApi()
    const state = await load(api)

    const outcome = await save(api, state, draftFor('doris'))

    expect(outcome).toMatchObject({ ok: false, field: 'name' })
    expect(api.save).not.toHaveBeenCalled()
  })

  it('saves a valid draft, selects it and closes the editor', async () => {
    const api = fakeApi()
    const state = await load(api)

    const outcome = await save(api, state, { ...draftFor('doris'), name: 'new', host: 'h', username: 'u' })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(api.save).toHaveBeenCalled()
    expect(outcome.state.editing).toBeNull()
    expect(outcome.state.connections.some(entry => entry.name === 'new')).toBe(true)
  })

  it('keeps the current selection when saving a second connection', async () => {
    const api = fakeApi()
    const state = await load(api)

    const outcome = await save(api, state, { ...draftFor('mysql'), name: 'second', host: 'h2', username: 'u2' })

    expect(outcome.ok && outcome.state.activeId).toBe(connId)
  })

  it('deletes a connection, drops its verdict and moves the selection', async () => {
    const api = fakeApi()
    const loaded = await load(api)
    const state = await test(api, loaded, connId)

    const next = await remove(api, state, connId)

    expect(api.remove).toHaveBeenCalledWith(connId)
    expect(next.connections).toEqual([])
    expect(next.verdicts).toEqual({})
    expect(next.activeId).toBeNull()
  })

  it('falls back to another connection when the active one is deleted', async () => {
    const other = createDataSource({ id: 'aaaa-bbbb', name: 'other', dbms: 'mysql', host: 'h2', username: 'u2' })
    const api = fakeApi({ list: async () => [doris, other] })
    const state = await load(api)

    const next = await remove(api, state, connId)

    expect(next.activeId).toBe(other.id)
  })

  it('previews a stored connection as an editable draft', () => {
    expect(toDraft(doris)).toMatchObject({ id: connId, port: 9030, writeEnabled: false })
  })

  it('applies engine defaults to a fresh draft', () => {
    expect(draftFor('mysql')).toMatchObject({ port: 3306 })
    expect(draftFor('doris', 'doris.shcell.com')).toMatchObject({ port: 9030, host: 'doris.shcell.com' })
  })
})

describe('workbench api lookup', () => {
  it('reads the service the node half published', async () => {
    const { SERVICE_NAME, workbenchApi } = await import('../src/client/api.ts')
    const service = {}

    expect(workbenchApi({ [SERVICE_NAME]: service })).toBe(service)
  })

  it('reports absence instead of throwing', async () => {
    const { workbenchApi } = await import('../src/client/api.ts')

    expect(workbenchApi({})).toBeUndefined()
  })
})

describe('draft projections cover every optional field', () => {
  it('keeps a database and a comment when the stored connection has them', () => {
    const withExtras = createDataSource({
      id: connId,
      name: 'doris',
      dbms: 'doris',
      host: 'h',
      username: 'u',
      database: 'dwd',
      comment: '内网',
    })

    expect(toDraft(withExtras)).toMatchObject({ database: 'dwd', comment: '内网' })
  })

  it('omits optional fields instead of writing undefined keys', () => {
    const bare = createDataSource({ id: connId, name: 'n', dbms: 'mysql', host: 'h', username: 'u' })

    expect('database' in toDraft(bare)).toBe(false)
    expect('comment' in toDraft(bare)).toBe(false)
  })

  it('describes a non-Error rejection', async () => {
    const state = await load(fakeApi({ list: async () => Promise.reject('plain string') }))

    expect(state.message).toBe('plain string')
  })
})

describe('saving with nothing selected yet', () => {
  it('selects the freshly saved connection', async () => {
    const api = fakeApi({ active: async () => null, list: async () => [] })
    const state = await load(api)

    const outcome = await save(api, state, { ...draftFor('doris'), name: 'first', host: 'h', username: 'u' })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.state.activeId).toBe(connId)
    expect(api.setActive).toHaveBeenCalledWith(connId)
  })
})

describe('deleting a connection that is not selected', () => {
  it('leaves the selection alone and does not re-select anything', async () => {
    const other = createDataSource({ id: 'aaaa-bbbb', name: 'other', dbms: 'mysql', host: 'h2', username: 'u2' })
    const api = fakeApi({ list: async () => [doris, other] })
    const state = await load(api)

    const next = await remove(api, state, other.id)

    expect(next.activeId).toBe(connId)
    expect(next.connections.map(entry => entry.id)).toEqual([connId])
    expect(api.setActive).not.toHaveBeenCalled()
  })
})

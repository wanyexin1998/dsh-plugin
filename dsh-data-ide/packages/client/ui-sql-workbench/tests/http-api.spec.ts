import { describe, expect, it, vi } from 'vitest'

import { createDataSource } from '../src/datasource/model.ts'
import type { DataSource } from '../src/datasource/model.ts'
import { createHttpApi, HTTP_ROUTES } from '../src/client/http-api.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const doris: DataSource = createDataSource({ id: connId, name: 'doris', dbms: 'doris', host: 'h', username: 'u' })

/** Build a fetch double answering the given payload per path. */
function fetchDouble(payloads: Record<string, unknown>, status = 200) {
  return vi.fn(async (input: string) => ({ ok: status < 400, status, json: async () => payloads[input] ?? {} }) as Response)
}

const okResult = { ok: true, columns: [], rows: [[1]], total: 1, hasNextPage: false, offset: 0, durationMs: 3, statementId: 'ui-1' }

describe('http panel api', () => {
  it('loads connections and the active id', async () => {
    const fetchImpl = fetchDouble({ [HTTP_ROUTES.connections]: { ok: true, connections: [doris], activeId: connId } })
    const api = createHttpApi(fetchImpl)

    expect(await api.list()).toEqual([doris])
    expect(await api.active()).toBe(connId)
    expect(fetchImpl).toHaveBeenCalledWith(HTTP_ROUTES.connections, { method: 'GET' })
  })

  it('reads a missing active id as null and a missing list as empty', async () => {
    const api = createHttpApi(fetchDouble({ [HTTP_ROUTES.connections]: { ok: true } }))

    expect(await api.list()).toEqual([])
    expect(await api.active()).toBeNull()
  })

  it('posts the draft and returns the stored connection', async () => {
    const fetchImpl = fetchDouble({ [HTTP_ROUTES.save]: { ok: true, connection: doris } })
    const api = createHttpApi(fetchImpl)

    await expect(api.save({ name: 'dor', dbms: 'doris', host: 'h', port: 9030, username: 'u' })).resolves.toEqual(doris)
    expect(fetchImpl).toHaveBeenCalledWith(
      HTTP_ROUTES.save,
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"draft"') }),
    )
  })

  it('reports the stored connection missing instead of returning undefined', async () => {
    const api = createHttpApi(fetchDouble({ [HTTP_ROUTES.save]: { ok: true } }))

    await expect(api.save({ name: 'd', dbms: 'doris', host: 'h', port: 9030, username: 'u' })).rejects.toThrow(/宿主未返回连接/)
  })

  it('sets the active connection, removes one and tests one', async () => {
    const fetchImpl = fetchDouble({
      [HTTP_ROUTES.activate]: { ok: true },
      [HTTP_ROUTES.remove]: { ok: true, removed: true },
      [HTTP_ROUTES.test]: { ok: true, result: { state: 'YES', durationMs: 9 } },
    })
    const api = createHttpApi(fetchImpl)

    await api.setActive(connId)
    expect(await api.remove(connId)).toBe(true)
    expect(await api.test(connId)).toEqual({ state: 'YES', durationMs: 9 })
    expect(fetchImpl).toHaveBeenCalledWith(HTTP_ROUTES.activate, expect.objectContaining({ body: `{"connId":"${connId}"}` }))
  })

  it('treats a missing removal flag as false and a missing test result as an error', async () => {
    const api = createHttpApi(fetchDouble({ [HTTP_ROUTES.remove]: { ok: true }, [HTTP_ROUTES.test]: { ok: true } }))

    expect(await api.remove(connId)).toBe(false)
    await expect(api.test(connId)).rejects.toThrow(/宿主未返回结果/)
  })

  it('runs, pages and cancels statements', async () => {
    const fetchImpl = fetchDouble({
      [HTTP_ROUTES.execute]: { ok: true, result: okResult },
      [HTTP_ROUTES.fetchPage]: { ok: true, result: { ...okResult, offset: 500, total: null } },
      [HTTP_ROUTES.cancel]: { ok: true, result: { cancelled: true } },
    })
    const api = createHttpApi(fetchImpl)

    expect(await api.execute({ connId, sql: 'SELECT 1' })).toMatchObject({ ok: true, rows: [[1]] })
    expect(await api.fetchPage({ connId, sql: 'SELECT 1', offset: 500 })).toMatchObject({ offset: 500 })
    expect(await api.cancel('ui-1')).toEqual({ cancelled: true })
  })

  it('reports a missing result envelope instead of pretending success', async () => {
    const api = createHttpApi(fetchDouble({ [HTTP_ROUTES.execute]: { ok: true }, [HTTP_ROUTES.fetchPage]: { ok: true } }))

    await expect(api.execute({ connId, sql: 'SELECT 1' })).rejects.toThrow(/宿主未返回结果/)
    await expect(api.fetchPage({ connId, sql: 'SELECT 1', offset: 0 })).rejects.toThrow(/宿主未返回结果/)
  })

  it('defaults a missing cancel result to not cancelled', async () => {
    const api = createHttpApi(fetchDouble({ [HTTP_ROUTES.cancel]: { ok: true } }))

    expect(await api.cancel('ui-404')).toEqual({ cancelled: false })
  })

  it('throws the host message on a failed envelope', async () => {
    const api = createHttpApi(
      fetchDouble({ [HTTP_ROUTES.execute]: { ok: false, error: { code: 'WRITE_NOT_ALLOWED', message: '只读' } } }, 200),
    )

    await expect(api.execute({ connId, sql: 'DELETE FROM t' })).rejects.toThrow('WRITE_NOT_ALLOWED: 只读')
  })

  it('falls back to the status code when the envelope says nothing', async () => {
    const api = createHttpApi(fetchDouble({ [HTTP_ROUTES.connections]: {} }, 500))

    await expect(api.list()).rejects.toThrow('HTTP_500: 请求失败（500）')
  })

  it('uses the global fetch by default', async () => {
    const stub = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, connections: [], activeId: null }) }) as Response)
    vi.stubGlobal('fetch', stub)

    const api = createHttpApi()
    await api.list()

    expect(stub).toHaveBeenCalledWith(HTTP_ROUTES.connections, { method: 'GET' })
    vi.unstubAllGlobals()
  })
})

describe('http panel api: schema', () => {
  const snapshot = { tables: [{ name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }] }], fetchedAt: '2026-10-19T00:00:00.000Z', truncated: false, source: 'information_schema' as const }

  /** Schema reads carry a query string, so match the path as a prefix. */
  const schemaFetch = (payload: unknown, status = 200) => vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => payload,
  }) as Response)

  it('reads the schema for a connection', async () => {
    const fetchImpl = schemaFetch({ ok: true, schema: snapshot })
    const api = createHttpApi(fetchImpl)

    await expect(api.schema(connId)).resolves.toEqual(snapshot)
    expect(fetchImpl).toHaveBeenCalledWith(`${HTTP_ROUTES.schema}?connId=${connId}`, { method: 'GET' })
  })

  it('asks for a refresh explicitly', async () => {
    const fetchImpl = schemaFetch({ ok: true, schema: snapshot })
    const api = createHttpApi(fetchImpl)

    await api.schema(connId, { refresh: true })

    expect(fetchImpl).toHaveBeenCalledWith(`${HTTP_ROUTES.schema}?connId=${connId}&refresh=1`, { method: 'GET' })
  })

  it('reports a missing schema instead of an empty one', async () => {
    const api = createHttpApi(schemaFetch({ ok: true }))

    await expect(api.schema(connId)).rejects.toThrow(/表结构/)
  })
})

describe('http panel api: execute-script', () => {
  it('posts the script and returns per-statement results', async () => {
    const script = { durationMs: 12, statements: [{ index: 0, sql: 'SELECT 1', ok: true, response: { columns: [], rows: [], total: 0, hasNextPage: false, offset: 0, durationMs: 3, statementId: 's' } }] }
    const api = createHttpApi(fetchDouble({ [HTTP_ROUTES.executeScript]: { ok: true, script } }))

    await expect(api.executeScript({ connId, sql: 'SELECT 1' })).resolves.toEqual(script)
  })

  it('surfaces a refusal instead of throwing', async () => {
    const api = createHttpApi(fetchDouble({ [HTTP_ROUTES.executeScript]: { ok: true, refusal: { code: 'EMPTY_SQL', message: '没有可执行的语句' } } }))

    await expect(api.executeScript({ connId, sql: ' ' })).resolves.toEqual({ refusal: { code: 'EMPTY_SQL', message: '没有可执行的语句' } })
  })

  it('reports a missing payload', async () => {
    const api = createHttpApi(fetchDouble({ [HTTP_ROUTES.executeScript]: { ok: true } }))

    await expect(api.executeScript({ connId, sql: 'SELECT 1' })).rejects.toThrow(/脚本执行失败/)
  })
})

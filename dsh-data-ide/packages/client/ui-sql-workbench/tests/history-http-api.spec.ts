import { describe, expect, it, vi } from 'vitest'

import { createHttpApi, HTTP_ROUTES } from '../src/client/http-api.ts'
import type { QueryHistoryEntry } from '../src/client/state/history.ts'

const connId = 'c1'
const entry: QueryHistoryEntry = {
  id: 'h1',
  connId,
  sql: 'SELECT 1',
  at: 1_000,
  durationMs: 5,
  rowCount: 1,
  ok: true,
}

/** Build a fetch double answering the given payload per path. */
function fetchDouble(payloads: Record<string, unknown>, status = 200) {
  return vi.fn(
    async (input: string) =>
      ({
        ok: status < 400,
        status,
        text: async () => JSON.stringify(payloads[input] ?? {}),
        json: async () => payloads[input] ?? {},
      }) as Response,
  )
}

const workspace = { schemaVersion: 1, activeDocId: 'a', docs: [{ id: 'a', sql: 'SELECT 1' }] }
const favorites = { schemaVersion: 1, entries: [{ id: 'fav-h1', name: '最近', sql: 'SELECT 1' }] }

describe('http panel api: persistence', () => {
  it('loads the console workspace and falls back to null when absent', async () => {
    const fetchImpl = fetchDouble({ [HTTP_ROUTES.workspace]: { ok: true, state: workspace } })
    const api = createHttpApi(fetchImpl)

    await expect(api.loadWorkspaceState!()).resolves.toEqual(workspace)
    expect(fetchImpl).toHaveBeenCalledWith(HTTP_ROUTES.workspace, { method: 'GET' })

    const missing = createHttpApi(fetchDouble({ [HTTP_ROUTES.workspace]: { ok: true } }))
    await expect(missing.loadWorkspaceState!()).resolves.toBeNull()
  })

  it('posts the workspace document and absorbs a failed save', async () => {
    const fetchImpl = fetchDouble({ [HTTP_ROUTES.workspace]: { ok: true } })
    const api = createHttpApi(fetchImpl)

    await expect(api.saveWorkspaceState!(workspace)).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith(
      HTTP_ROUTES.workspace,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ state: workspace }) }),
    )

    const offline = createHttpApi(fetchDouble({ [HTTP_ROUTES.workspace]: { ok: false } }, 500))
    await expect(offline.saveWorkspaceState!(workspace)).resolves.toBeUndefined()
  })

  it('loads the history document and falls back to null when absent', async () => {
    const history = { schemaVersion: 1, byConn: { [connId]: [entry] } }
    const fetchImpl = fetchDouble({ [HTTP_ROUTES.history]: { ok: true, history } })
    const api = createHttpApi(fetchImpl)

    await expect(api.loadHistory!()).resolves.toEqual(history)
    expect(fetchImpl).toHaveBeenCalledWith(HTTP_ROUTES.history, { method: 'GET' })

    const missing = createHttpApi(fetchDouble({ [HTTP_ROUTES.history]: { ok: true } }))
    await expect(missing.loadHistory!()).resolves.toBeNull()
  })

  it('appends one run and absorbs a failed append', async () => {
    const fetchImpl = fetchDouble({ [HTTP_ROUTES.history]: { ok: true } })
    const api = createHttpApi(fetchImpl)

    await expect(api.appendHistory!(entry)).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith(
      HTTP_ROUTES.history,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ entry }) }),
    )

    const offline = createHttpApi(fetchDouble({ [HTTP_ROUTES.history]: { ok: false } }, 500))
    await expect(offline.appendHistory!(entry)).resolves.toBeUndefined()
  })

  it('loads and saves the favorites document', async () => {
    const fetchImpl = fetchDouble({
      [HTTP_ROUTES.favorites]: { ok: true, favorites },
    })
    const api = createHttpApi(fetchImpl)

    await expect(api.loadFavorites!()).resolves.toEqual(favorites)
    await expect(api.saveFavorites!(favorites)).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith(
      HTTP_ROUTES.favorites,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ favorites }) }),
    )

    const missing = createHttpApi(fetchDouble({ [HTTP_ROUTES.favorites]: { ok: true } }))
    await expect(missing.loadFavorites!()).resolves.toBeNull()
  })

  it('absorbs a failed favorites save', async () => {
    const api = createHttpApi(fetchDouble({ [HTTP_ROUTES.favorites]: { ok: false } }, 500))

    await expect(api.saveFavorites!(favorites)).resolves.toBeUndefined()
  })
})

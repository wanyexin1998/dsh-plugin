import { beforeEach, describe, expect, it } from 'vitest'

import {
  type CredentialRecordEntry,
  type CredentialsPort,
  createCredentialStore,
  CREDENTIAL_SCOPE,
  credentialKey,
  pruneOrphanCredentials,
} from '../src/host/credentials.ts'

/** In-memory stand-in for `ctx.credentials`. */
function fakeCredentials(): CredentialsPort & { readonly records: Map<string, unknown> } {
  const records = new Map<string, unknown>()
  return {
    records,
    readRecord: async key => records.get(key),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key))
      if (next === undefined) return undefined
      records.set(key, next)
      return next
    },
    deleteRecord: async key => {
      records.delete(key)
    },
    listRecords: async (): Promise<readonly CredentialRecordEntry[]> =>
      [...records.keys()].map(key => ({ key })),
  }
}

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const otherId = '11111111-2222-3333-4444-555555555555'

describe('credential keys', () => {
  it('is two segments under our scope, with the id normalised', () => {
    expect(credentialKey(connId)).toBe(`${CREDENTIAL_SCOPE}/ds-f02da6e0`)
  })
})

describe('credential store', () => {
  let host: ReturnType<typeof fakeCredentials>
  let store: ReturnType<typeof createCredentialStore>

  beforeEach(() => {
    host = fakeCredentials()
    store = createCredentialStore(host)
  })

  it('writes the tagged record the host accepts', async () => {
    await store.set(connId, 'hunter2', 'master_key')

    // `parseRecord` in dsh-credentials-local only admits {kind, payload}; a flat
    // record made the credentials plugin fail to boot (2026-10-19).
    expect(host.records.get(credentialKey(connId))).toEqual({
      kind: 'grant',
      payload: { version: 1, password: 'hunter2', secretStorage: 'master_key' },
    })
    expect(await store.resolve(connId)).toBe('hunter2')
  })

  it('still reads a flat record written before the fix', async () => {
    host.records.set(credentialKey(connId), { password: 'legacy', secretStorage: 'master_key' })

    expect(await store.resolve(connId)).toBe('legacy')
  })

  it('reads nothing from a record the host would have rejected as unknown', async () => {
    host.records.set(credentialKey(connId), { kind: 'grant' })
    expect(await store.resolve(connId)).toBeUndefined()

    host.records.set(credentialKey(connId), { kind: 'grant', payload: { password: 'x', secretStorage: 'nope' } })
    expect(await store.resolve(connId)).toBeUndefined()
  })

  it('keeps a session secret in memory and writes nothing to the host', async () => {
    await store.set(connId, 'ephemeral', 'session')

    expect(host.records.size).toBe(0)
    expect(await store.resolve(connId)).toBe('ephemeral')
    expect(store.sessionCount()).toBe(1)
  })

  it('deletes a persisted copy when switching to session-only storage', async () => {
    await store.set(connId, 'persisted', 'master_key')
    await store.set(connId, 'ephemeral', 'session')

    expect(host.records.has(credentialKey(connId))).toBe(false)
    expect(await store.resolve(connId)).toBe('ephemeral')
  })

  it('drops the session copy when switching back to a persisted secret', async () => {
    await store.set(connId, 'ephemeral', 'session')
    await store.set(connId, 'persisted', 'master_key')

    expect(store.sessionCount()).toBe(0)
    expect(await store.resolve(connId)).toBe('persisted')
  })

  it('resolves nothing for an unknown connection', async () => {
    expect(await store.resolve('ds-00000000')).toBeUndefined()
  })

  it('treats a malformed record as absent rather than trusting it', async () => {
    host.records.set(credentialKey(connId), { password: 42 })
    expect(await store.resolve(connId)).toBeUndefined()

    host.records.set(credentialKey(connId), { password: 'x', secretStorage: 'elsewhere' })
    expect(await store.resolve(connId)).toBeUndefined()

    host.records.set(credentialKey(connId), 'plain string')
    expect(await store.resolve(connId)).toBeUndefined()
  })

  it('removes both the record and the session copy', async () => {
    await store.set(connId, 'persisted', 'master_key')
    await store.set('11111111-1111-1111-1111-111111111111', 'ephemeral', 'session')

    await store.remove(connId)

    expect(await store.resolve(connId)).toBeUndefined()
    expect(host.records.has(credentialKey(connId))).toBe(false)
    expect(store.sessionCount()).toBe(1)
  })

  it('lists only the ids under our scope', async () => {
    await store.set(connId, 'a', 'master_key')
    await store.set(otherId, 'b', 'master_key')
    host.records.set('other-scope/ds-33333333', { password: 'c' })

    expect([...(await store.storedIds())].sort()).toEqual(['ds-11111111', 'ds-f02da6e0'])
  })
})

describe('orphan cleanup', () => {
  it('drops credentials whose connection is gone', async () => {
    const host = fakeCredentials()
    const store = createCredentialStore(host)
    await store.set(connId, 'a', 'master_key')
    await store.set(otherId, 'b', 'master_key')

    const dropped = await pruneOrphanCredentials(store, [otherId])

    expect(dropped).toEqual(['ds-f02da6e0'])
    expect(await store.resolve(connId)).toBeUndefined()
    expect(await store.resolve(otherId)).toBe('b')
  })

  it('does nothing when every credential still has a connection', async () => {
    const host = fakeCredentials()
    const store = createCredentialStore(host)
    await store.set(connId, 'a', 'master_key')

    expect(await pruneOrphanCredentials(store, [connId])).toEqual([])
    expect(await store.resolve(connId)).toBe('a')
  })

  it('copes with a host that lists nothing', async () => {
    const store = createCredentialStore(fakeCredentials())

    expect(await pruneOrphanCredentials(store, [])).toEqual([])
  })
})

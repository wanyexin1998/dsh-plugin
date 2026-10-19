import { describe, expect, it, vi } from 'vitest'

import { createConnectionResolver } from '../src/host/binding.ts'
import { createDataSource } from '../src/datasource/model.ts'
import type { DataSourceStore } from '../src/datasource/store.ts'
import type { CredentialStore } from '../src/host/credentials.ts'
import type { RuntimeSpecDocument } from '../src/host/runtime-specs.ts'

const source = createDataSource({
  id: 'conn-1',
  name: 'doris',
  dbms: 'doris',
  host: 'doris.shcell.com',
  port: 9030,
  username: 'ai_reader',
  database: 'dwd',
})

const document: RuntimeSpecDocument = {
  schemaVersion: 1,
  generatedAt: '2026-10-19T00:00:00.000Z',
  connections: {
    'conn-1': {
      name: 'doris',
      dbms: 'doris',
      host: 'doris.shcell.com',
      port: 9030,
      database: 'dwd',
      username: 'ai_reader',
      password: 'from-document',
      driverProperties: {},
      writeEnabled: false,
    },
  },
}

/** Store double answering a single connection. */
const store = (found: boolean): DataSourceStore =>
  ({ get: async (id: string) => (found && id === 'conn-1' ? source : undefined) }) as unknown as DataSourceStore

/** Credential double: `undefined` models a connection whose secret is gone. */
const secrets = (password: string | undefined): CredentialStore =>
  ({
    resolve: async () => password,
    storedIds: async () => [],
    sessionCount: () => 0,
  }) as unknown as CredentialStore

describe('connection resolver (execute parity)', () => {
  it('returns the spec the execute path would use', async () => {
    const resolve = createConnectionResolver({
      specs: async () => document,
      dataSources: store(false),
      credentials: secrets(undefined),
    })

    await expect(resolve('conn-1')).resolves.toMatchObject({ password: 'from-document' })
  })

  it('rebuilds the spec when the document has not caught up yet', async () => {
    const resolve = createConnectionResolver({
      specs: async () => ({ ...document, connections: {} }),
      dataSources: store(true),
      credentials: secrets('from-session'),
    })

    await expect(resolve('conn-1')).resolves.toMatchObject({
      host: 'doris.shcell.com',
      username: 'ai_reader',
      password: 'from-session',
      database: 'dwd',
    })
  })

  it('returns nothing when neither the document nor the store knows the connection', async () => {
    const resolve = createConnectionResolver({
      specs: async () => ({ ...document, connections: {} }),
      dataSources: store(false),
      credentials: secrets('whatever'),
    })

    await expect(resolve('conn-1')).resolves.toBeUndefined()
  })

  it('returns nothing when the store knows it but the secret is gone', async () => {
    const resolve = createConnectionResolver({
      specs: async () => ({ ...document, connections: {} }),
      dataSources: store(true),
      credentials: secrets(undefined),
    })

    await expect(resolve('conn-1')).resolves.toBeUndefined()
  })

  it('asks the store only after the document misses', async () => {
    const get = vi.fn(async () => source)
    const resolve = createConnectionResolver({
      specs: async () => document,
      dataSources: { get } as unknown as DataSourceStore,
      credentials: secrets('unused'),
    })

    await resolve('conn-1')

    expect(get).not.toHaveBeenCalled()
  })
})

describe('connection resolver: diagnostics', () => {
  it('logs why a connection could not be resolved', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const resolve = createConnectionResolver({
      specs: async () => ({ ...document, connections: {} }),
      dataSources: store(false),
      credentials: secrets(undefined),
    })

    await resolve('conn-1')

    expect(logged.mock.calls[0]?.[0]).toContain('connection not in the store')
    logged.mockRestore()
  })

  it('logs the secret situation when the password is missing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const credentials = {
      resolve: async () => undefined,
      storedIds: async () => ['ds-other'],
      sessionCount: () => 2,
    } as unknown as CredentialStore
    const resolve = createConnectionResolver({
      specs: async () => ({ ...document, connections: {} }),
      dataSources: store(true),
      credentials,
    })

    await resolve('conn-1')

    const line = String(logged.mock.calls[0]?.join(' '))
    expect(line).toContain('no secret for')
    expect(line).toContain('ds-other')
    logged.mockRestore()
  })
})

describe('connection resolver: connection without a database', () => {
  it('omits the field instead of setting it to undefined', async () => {
    const bare = createDataSource({ id: 'conn-1', name: 'mysql', dbms: 'mysql', host: 'h', username: 'u' })
    const resolve = createConnectionResolver({
      specs: async () => ({ ...document, connections: {} }),
      dataSources: { get: async () => bare } as unknown as DataSourceStore,
      credentials: secrets('p'),
    })

    const spec = await resolve('conn-1')

    expect(spec).toBeDefined()
    expect('database' in (spec as object)).toBe(false)
  })
})

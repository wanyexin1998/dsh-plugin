import { describe, expect, it } from 'vitest'

import { createMemoryKvStore } from '../src/host/kv.ts'
import { createDataSource, credentialId, DBMS_DEFAULTS, validateDataSource } from '../src/datasource/model.ts'
import { createDataSourceStore } from '../src/datasource/store.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'

describe('engine defaults', () => {
  it('targets the Doris FE port with the batch rewrite DataGrip was observed using', () => {
    expect(DBMS_DEFAULTS.doris).toEqual({ port: 9030, driverProperties: { rewriteBatchedStatements: 'TRUE' } })
  })

  it('falls back to the MySQL port with no extra driver properties', () => {
    expect(DBMS_DEFAULTS.mysql).toEqual({ port: 3306, driverProperties: {} })
  })

  it('lets an explicit port and extra properties win', () => {
    const source = createDataSource({
      id: connId,
      name: 'doris.shcell.com',
      dbms: 'doris',
      host: 'doris.shcell.com',
      port: 9031,
      username: 'wanyexin',
      database: 'dwd',
      driverProperties: { connectTimeout: '5000' },
      comment: '内网',
    })

    expect(source.port).toBe(9031)
    expect(source.driverProperties).toEqual({ rewriteBatchedStatements: 'TRUE', connectTimeout: '5000' })
    expect(source.database).toBe('dwd')
    expect(source.comment).toBe('内网')
  })

  it('never invents a database or comment, and keeps writes off by default', () => {
    const source = createDataSource({ id: connId, name: 'n', dbms: 'mysql', host: 'h', username: 'u' })

    expect('database' in source).toBe(false)
    expect('comment' in source).toBe(false)
    expect(source.writeEnabled).toBe(false)
  })
})

describe('validation', () => {
  const base = { name: 'n', dbms: 'mysql' as const, host: 'h', port: 3306, username: 'u' }

  it('accepts a complete draft', () => {
    expect(validateDataSource(base)).toEqual({ ok: true })
  })

  it('names the offending field', () => {
    expect(validateDataSource({ ...base, name: '  ' })).toMatchObject({ ok: false, field: 'name' })
    expect(validateDataSource({ ...base, host: '' })).toMatchObject({ ok: false, field: 'host' })
    expect(validateDataSource({ ...base, username: '' })).toMatchObject({ ok: false, field: 'username' })
    expect(validateDataSource({ ...base, port: 0 })).toMatchObject({ ok: false, field: 'port' })
    expect(validateDataSource({ ...base, port: 70_000 })).toMatchObject({ ok: false, field: 'port' })
    expect(validateDataSource({ ...base, port: 3306.5 })).toMatchObject({ ok: false, field: 'port' })
  })
})

describe('credential id', () => {
  it('maps a UUID onto the credential-key alphabet', () => {
    expect(credentialId(connId)).toBe('ds-f02da6e0')
  })

  it('pads a short id instead of producing a malformed key', () => {
    expect(credentialId('abc')).toBe('ds-abc00000')
  })

  it('always satisfies the [a-z][a-z0-9-]* key rule', () => {
    expect(credentialId(connId)).toMatch(/^ds-[0-9a-f]{8}$/)
  })
})

describe('data source store', () => {
  const source = createDataSource({ id: connId, name: 'doris', dbms: 'doris', host: 'doris.shcell.com', username: 'wanyexin' })

  it('starts empty', async () => {
    const store = createDataSourceStore(createMemoryKvStore())

    expect(await store.list()).toEqual([])
    expect(await store.active()).toBeNull()
  })

  it('round-trips a connection and reads it back by id', async () => {
    const store = createDataSourceStore(createMemoryKvStore())

    await store.save(source)

    expect(await store.list()).toEqual([source])
    expect(await store.get(connId)).toEqual(source)
  })

  it('replaces rather than duplicates on re-save', async () => {
    const store = createDataSourceStore(createMemoryKvStore())

    await store.save(source)
    await store.save({ ...source, name: 'renamed' })

    expect(await store.list()).toHaveLength(1)
    expect((await store.get(connId))?.name).toBe('renamed')
  })

  it('removes a connection and reports whether it existed', async () => {
    const store = createDataSourceStore(createMemoryKvStore())
    await store.save(source)

    expect(await store.remove(connId)).toBe(true)
    expect(await store.remove(connId)).toBe(false)
    expect(await store.list()).toEqual([])
  })

  it('clears the active selection when its connection disappears', async () => {
    const store = createDataSourceStore(createMemoryKvStore())
    await store.save(source)
    await store.setActive(connId)

    await store.remove(connId)

    expect(await store.active()).toBeNull()
  })

  it('keeps the active selection when another connection disappears', async () => {
    const store = createDataSourceStore(createMemoryKvStore())
    const other = createDataSource({ id: 'aaaa-bbbb', name: 'other', dbms: 'mysql', host: 'h2', username: 'u2' })
    await store.save(source)
    await store.save(other)
    await store.setActive(connId)

    await store.remove(other.id)

    expect(await store.active()).toBe(connId)
  })

  it('caches the connection-test outcome with its product facts', async () => {
    const store = createDataSourceStore(createMemoryKvStore())
    await store.save(source)

    await store.recordTestResult(connId, 'YES', '2026-10-17T00:00:00.000Z', {
      product: 'MySQL',
      version: '5.7.99',
      driverVersion: 'mysql2 3.11.0',
      dbms: 'MYSQL',
      identifierQuoteString: '`',
      caseSensitivity: { plain: 'lower', quoted: 'exact' },
    })

    const updated = await store.get(connId)
    expect(updated?.lastTestState).toBe('YES')
    expect(updated?.lastTestedAt).toBe('2026-10-17T00:00:00.000Z')
    expect(updated?.databaseInfo?.version).toBe('5.7.99')
  })

  it('records a failed test without inventing product facts', async () => {
    const store = createDataSourceStore(createMemoryKvStore())
    await store.save(source)

    await store.recordTestResult(connId, 'NO', '2026-10-17T00:00:01.000Z')

    const updated = await store.get(connId)
    expect(updated?.lastTestState).toBe('NO')
    expect('databaseInfo' in (updated ?? {})).toBe(false)
  })

  it('leaves other connections untouched when recording a result', async () => {
    const store = createDataSourceStore(createMemoryKvStore())
    const other = createDataSource({ id: 'aaaa-bbbb', name: 'other', dbms: 'mysql', host: 'h2', username: 'u2' })
    await store.save(source)
    await store.save(other)

    await store.recordTestResult(connId, 'UNSURE', '2026-10-17T00:00:02.000Z')

    expect((await store.get(other.id))?.lastTestState).toBeUndefined()
  })

  it('isolates malformed records instead of failing the whole store', async () => {
    const kv = createMemoryKvStore({
      datasources: {
        schemaVersion: 1,
        activeConnId: null,
        dataSources: [source, { id: 'broken' }, 'nonsense', null],
      },
    })
    const store = createDataSourceStore(kv)

    expect(await store.list()).toEqual([source])
  })

  it('recovers from a corrupt document by starting clean', async () => {
    const store = createDataSourceStore(createMemoryKvStore({ datasources: 'not-an-object' }))

    expect(await store.list()).toEqual([])
  })

  it('defaults a missing active id when reading an older document', async () => {
    const store = createDataSourceStore(
      createMemoryKvStore({ datasources: { schemaVersion: 1, dataSources: [source] } }),
    )

    expect(await store.active()).toBeNull()
  })
})

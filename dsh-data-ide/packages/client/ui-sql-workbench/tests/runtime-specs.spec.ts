import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDataSource } from '../src/datasource/model.ts'
import {
  buildRuntimeSpecs,
  removeRuntimeSpecs,
  RUNTIME_SPEC_SEGMENTS,
  runtimeSpecPath,
  writeRuntimeSpecs,
} from '../src/host/runtime-specs.ts'
import { parseRuntimeSpecs, redactDataSources, resolveSpec, loadRuntimeSpecs } from '../mcp/runtime-specs.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const source = createDataSource({
  id: connId,
  name: 'doris.shcell.com',
  dbms: 'doris',
  host: 'doris.shcell.com',
  port: 9030,
  database: 'dwd',
  username: 'wanyexin',
})

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-data-ide-specs-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('building runtime specs', () => {
  it('resolves the password into the spec the server needs', async () => {
    const outcome = await buildRuntimeSpecs([source], async () => 'hunter2', () => Date.parse('2026-10-17T00:00:00Z'))

    expect(outcome.included).toEqual([source])
    expect(outcome.missing).toEqual([])
    expect(outcome.document.connections[connId]).toEqual({
      name: 'doris.shcell.com',
      dbms: 'doris',
      host: 'doris.shcell.com',
      port: 9030,
      database: 'dwd',
      username: 'wanyexin',
      password: 'hunter2',
      driverProperties: { rewriteBatchedStatements: 'TRUE' },
      writeEnabled: false,
    })
    expect(outcome.document.generatedAt).toBe('2026-10-17T00:00:00.000Z')
  })

  it('skips a connection whose password cannot be resolved', async () => {
    const outcome = await buildRuntimeSpecs([source], async () => undefined)

    expect(outcome.included).toEqual([])
    expect(outcome.missing).toEqual([connId])
    expect(Object.keys(outcome.document.connections)).toEqual([])
  })
})

describe('spec file lifecycle', () => {
  it('writes an owner-only file that the server can read back', async () => {
    const { document } = await buildRuntimeSpecs([source], async () => 'hunter2')
    const file = join(directory, 'conn-specs.json')

    await writeRuntimeSpecs(file, document)

    const mode = (await stat(file)).mode & 0o777
    if (process.platform !== 'win32') expect(mode).toBe(0o600)
    expect((await loadRuntimeSpecs(file)).connections[connId]?.password).toBe('hunter2')
  })

  it('leaves no temp file behind after a successful write', async () => {
    const { document } = await buildRuntimeSpecs([source], async () => 'hunter2')
    const file = join(directory, 'conn-specs.json')

    await writeRuntimeSpecs(file, document)

    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('removes the file and its temp sibling on unload', async () => {
    const file = join(directory, 'conn-specs.json')
    await writeRuntimeSpecs(file, { schemaVersion: 1, generatedAt: 'now', connections: {} })
    await writeFile(`${file}.tmp`, '{}', 'utf8')

    await removeRuntimeSpecs(file)

    await expect(readFile(file, 'utf8')).rejects.toThrow()
    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('tolerates removing a file that was never written', async () => {
    await expect(removeRuntimeSpecs(join(directory, 'absent.json'))).resolves.toBeUndefined()
  })

  it('keeps the file under the harness home', () => {
    expect(RUNTIME_SPEC_SEGMENTS).toEqual(['data-ide-runtime', 'conn-specs.json'])
    expect(runtimeSpecPath('C:/Users/x/.dsh').replace(/\\/g, '/')).toBe('C:/Users/x/.dsh/data-ide-runtime/conn-specs.json')
  })
})

describe('server-side parsing', () => {
  it('round-trips a document', () => {
    const document = {
      schemaVersion: 1 as const,
      generatedAt: '2026-10-17T00:00:00.000Z',
      connections: {
        [connId]: {
          name: 'doris',
          dbms: 'doris' as const,
          host: 'h',
          port: 9030,
          username: 'u',
          password: 'p',
          driverProperties: {},
          writeEnabled: false,
        },
      },
    }

    expect(parseRuntimeSpecs(JSON.stringify(document))).toEqual(document)
  })

  it('rejects an unsupported schema version', () => {
    expect(() => parseRuntimeSpecs(JSON.stringify({ schemaVersion: 2, generatedAt: 'x', connections: {} }))).toThrow(
      /schemaVersion/,
    )
  })

  it('drops structurally invalid connections instead of failing the whole file', () => {
    const parsed = parseRuntimeSpecs(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: 'x',
        connections: { good: { name: 'a', dbms: 'doris', host: 'h', port: 1, username: 'u', password: 'p', driverProperties: {}, writeEnabled: false }, bad: { host: 'h' } },
      }),
    )

    expect(Object.keys(parsed.connections)).toEqual(['good'])
  })
})

describe('redaction and resolution', () => {
  const document = {
    schemaVersion: 1 as const,
    generatedAt: 'x',
    connections: {
      [connId]: {
        name: 'doris.shcell.com',
        dbms: 'doris' as const,
        host: 'doris.shcell.com',
        port: 9030,
        database: 'dwd',
        username: 'wanyexin',
        password: 'hunter2',
        driverProperties: {},
        writeEnabled: true,
      },
    },
  }

  it('never lets a password reach the agent', () => {
    const redacted = redactDataSources(document)

    expect(redacted).toEqual([
      {
        id: connId,
        name: 'doris.shcell.com',
        dbms: 'doris',
        host: 'doris.shcell.com',
        port: 9030,
        database: 'dwd',
        writeEnabled: true,
      },
    ])
    expect(JSON.stringify(redacted)).not.toContain('hunter2')
  })

  it('omits an absent database rather than sending null', () => {
    const withoutDatabase = {
      ...document,
      connections: { [connId]: { ...document.connections[connId]!, database: undefined } },
    }

    expect('database' in redactDataSources(withoutDatabase)[0]!).toBe(false)
  })

  it('resolves a known connection and explains an unknown one', () => {
    expect(resolveSpec(document, connId)).toMatchObject({ ok: true })
    expect(resolveSpec(document, 'nope')).toMatchObject({ ok: false, code: 'CONN_NOT_FOUND' })
  })
})

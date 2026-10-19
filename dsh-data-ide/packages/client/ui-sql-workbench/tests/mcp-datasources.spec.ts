import { describe, expect, it } from 'vitest'

import { type ConnectionProbe, classifyProbeError, isSuccess } from '../mcp/probe.ts'
import { LIST_DATASOURCES, TEST_CONNECTION, listDatasources, testConnection } from '../mcp/tools-datasources.ts'
import type { RuntimeSpecDocument } from '../src/host/runtime-specs.ts'

const connId = 'ds-f02da6e0'

const document: RuntimeSpecDocument = {
  schemaVersion: 1,
  generatedAt: '2026-10-17T00:00:00.000Z',
  connections: {
    [connId]: {
      name: 'doris.shcell.com',
      dbms: 'doris',
      host: 'doris.shcell.com',
      port: 9030,
      username: 'wanyexin',
      password: 'hunter2',
      driverProperties: {},
      writeEnabled: false,
    },
  },
}

const yes: ConnectionProbe = async () => ({
  state: 'YES',
  info: {
    product: 'Doris',
    version: '5.7.99',
    driverVersion: 'mysql2 3.24.6',
    dbms: 'MYSQL',
    identifierQuoteString: '`',
    caseSensitivity: { plain: 'lower', quoted: 'exact' },
  },
})

describe('list_datasources', () => {
  it('is named for the agent-facing surface', () => {
    expect([LIST_DATASOURCES, TEST_CONNECTION]).toEqual(['list_datasources', 'test_connection'])
  })

  it('returns connections without secrets', () => {
    const result = listDatasources(document)

    expect(result.ok).toBe(true)
    expect(JSON.stringify(result.payload)).not.toContain('hunter2')
    expect(result.payload.datasources[0]?.id).toBe(connId)
  })

  it('returns an empty list when the host published nothing', () => {
    expect(listDatasources({ schemaVersion: 1, generatedAt: 'x', connections: {} }).payload.datasources).toEqual([])
  })
})

describe('test_connection', () => {
  it('reports YES with cached product facts', async () => {
    const result = await testConnection(document, connId, yes)

    expect(result).toMatchObject({ ok: true, payload: { state: 'YES', info: { product: 'Doris' } } })
  })

  it('reports NO with an actionable reason', async () => {
    const failing: ConnectionProbe = async () => ({
      state: 'NO',
      error: { code: 'AUTH_FAILED', message: "Access denied for user 'wanyexin'", hint: '检查用户名与密码' },
    })

    expect(await testConnection(document, connId, failing)).toMatchObject({
      ok: true,
      payload: { state: 'NO', error: { code: 'AUTH_FAILED', hint: '检查用户名与密码' } },
    })
  })

  it('passes UNSURE through unchanged', async () => {
    const unsure: ConnectionProbe = async () => ({
      state: 'UNSURE',
      error: { code: 'UNKNOWN', message: '连接被重置' },
    })

    expect(await testConnection(document, connId, unsure)).toMatchObject({ payload: { state: 'UNSURE' } })
  })

  it('hands the probe the resolved spec, password included', async () => {
    const seen: string[] = []
    const spy: ConnectionProbe = async spec => {
      seen.push(`${spec.host}:${spec.port}/${spec.username}/${spec.password}`)
      return { state: 'UNSURE', error: { code: 'UNKNOWN', message: 'x' } }
    }

    await testConnection(document, connId, spy)

    expect(seen).toEqual(['doris.shcell.com:9030/wanyexin/hunter2'])
  })

  it('refuses an unknown connection before touching the network', async () => {
    let called = false
    const spy: ConnectionProbe = async () => {
      called = true
      return { state: 'UNSURE', error: { code: 'UNKNOWN', message: 'x' } }
    }

    const result = await testConnection(document, 'ds-00000000', spy)

    expect(result).toMatchObject({ ok: false, error: { code: 'CONN_NOT_FOUND' } })
    expect(called).toBe(false)
  })
})

describe('error classification', () => {
  it('maps auth failures to a credential hint', () => {
    const error = classifyProbeError({ code: 'ER_ACCESS_DENIED_ERROR', message: 'Access denied' })

    expect(error.code).toBe('AUTH_FAILED')
    expect(error.hint).toContain('密码')
  })

  it('maps the numeric MySQL auth errno too', () => {
    expect(classifyProbeError({ code: 28000, message: 'denied' }).code).toBe('AUTH_FAILED')
  })

  it('maps unreachable hosts to a network hint', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT']) {
      expect(classifyProbeError({ code, message: 'x' }).code).toBe('NETWORK_UNREACHABLE')
    }
  })

  it('maps a dropped protocol connection to a timeout', () => {
    expect(classifyProbeError({ code: 'PROTOCOL_CONNECTION_LOST', message: 'x' }).code).toBe('TIMEOUT')
  })

  it('maps a missing driver module', () => {
    expect(classifyProbeError({ code: 'MODULE_NOT_FOUND', message: 'x' }).code).toBe('DRIVER_MISSING')
  })

  it('falls back to UNKNOWN with the original message', () => {
    expect(classifyProbeError({ code: 'WAT', message: 'boom' })).toEqual({ code: 'UNKNOWN', message: 'boom' })
    expect(classifyProbeError(undefined).message).toBe('undefined')
  })

  it('narrows a successful outcome', () => {
    expect(isSuccess({ state: 'YES', info: document && ({} as never) })).toBe(true)
    expect(isSuccess({ state: 'NO', error: { code: 'UNKNOWN', message: 'x' } })).toBe(false)
  })
})

describe('spec document resilience', () => {
  it('drops non-object connection entries', async () => {
    const { parseRuntimeSpecs } = await import('../mcp/runtime-specs.ts')

    const parsed = parseRuntimeSpecs(
      JSON.stringify({ schemaVersion: 1, generatedAt: 'x', connections: { a: null, b: 7, c: { host: 'h' } } }),
    )

    expect(Object.keys(parsed.connections)).toEqual([])
  })
})

describe('driver version reporting', () => {
  it('reads the installed manifest version', async () => {
    const { resolveDriverVersion } = await import('../mcp/probe-mysql.ts')

    expect(resolveDriverVersion(() => '3.24.6')).toBe('mysql2 3.24.6')
  })

  it('defaults to reading the manifest that ships with the bundle', async () => {
    const { resolveDriverVersion } = await import('../mcp/probe-mysql.ts')

    expect(resolveDriverVersion()).toMatch(/^mysql2 \d+\./)
  })

  it('falls back to a bare name when the manifest cannot be read', async () => {
    const { resolveDriverVersion } = await import('../mcp/probe-mysql.ts')

    expect(
      resolveDriverVersion(() => {
        throw new Error('missing manifest')
      }),
    ).toBe('mysql2')
  })
})

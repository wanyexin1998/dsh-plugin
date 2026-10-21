import { describe, expect, it } from 'vitest'

import { PING_INPUT_SHAPE, PING_TOOL, ping, TOOL_NAMES } from '../mcp/tools.ts'

describe('ping', () => {
  it('answers with a probe payload on an injected clock', () => {
    expect(ping(() => Date.parse('2026-10-17T00:00:00.000Z'))).toEqual({
      ok: true,
      pong: 'pong',
      server: 'dsh-data-ide',
      at: '2026-10-17T00:00:00.000Z',
    })
  })

  it('defaults to the wall clock', () => {
    const before = Date.now()

    const result = ping()

    expect(Date.parse(result.at)).toBeGreaterThanOrEqual(before - 1000)
  })

  it('takes no arguments, so the published schema stays empty', () => {
    expect(PING_INPUT_SHAPE).toEqual({})
  })

  it('registers the connection tools alongside ping, for the agent-facing surface', () => {
    expect(TOOL_NAMES).toEqual([
      'ping',
      'list_datasources',
      'test_connection',
      'get_schema',
      'list_tables',
      'execute_sql',
      'execute_script',
      'fetch_page',
      'cancel_statement',
    ])
    expect(PING_TOOL).toBe('ping')
  })
})

/**
 * Tool surface of the SQL MCP server.
 *
 * Kept free of SDK imports so the schemas and handlers stay unit-testable and
 * the transport layer in `server.ts` stays a thin wiring shell. Tool names are
 * part of the agent-facing contract (`mcp__sql__<tool>`, 05 §3).
 */

/** Tool name; the agent sees it as `mcp__sql__ping`. */
export const PING_TOOL = 'ping'

/**
 * `ping` takes no arguments, declared as the empty raw shape the MCP SDK
 * accepts; the wire schema it derives is `{ type: 'object', properties: {} }`.
 */
export const PING_INPUT_SHAPE = {}

/** Result payload of `ping`. */
export interface PingResult {
  readonly ok: true
  readonly pong: 'pong'
  readonly server: string
  readonly at: string
}

/**
 * Liveness probe: proves the MCP server is installed, wired to the plugin, and
 * reachable by the agent (AC-5).
 *
 * @param now - clock injection point for tests.
 * @returns the probe payload.
 */
export function ping(now: () => number = Date.now): PingResult {
  return { ok: true, pong: 'pong', server: 'dsh-data-ide', at: new Date(now()).toISOString() }
}

/** Every tool this server exposes, in registration order. */
export const TOOL_NAMES: readonly string[] = [
  PING_TOOL,
  'list_datasources',
  'test_connection',
  'get_schema',
  'list_tables',
  'execute_sql',
  'execute_script',
  'fetch_page',
  'cancel_statement',
]

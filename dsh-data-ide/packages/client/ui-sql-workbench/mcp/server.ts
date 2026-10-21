/**
 * MCP server (stdio) shipped inside the dsh-data-ide plugin.
 *
 * The profile's bundle patch declares one `@deepseek-ai/dsh-mcp-client` instance
 * with `serverName: sql`, which spawns this file and exposes its tools to the
 * agent as `mcp__sql__*` (docs/05 §2). The server is stateless: connection
 * specs and passwords arrive through the host's runtime spec file, never from a
 * credential store of its own.
 */

import { randomUUID } from 'node:crypto'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'

import { createMysqlExecutor } from '../src/execute/mysql.ts'
import { cancelStatement, runExecuteSql, runFetchPage } from '../src/execute/envelope.ts'
import type { ExecutionResult } from '../src/execute/envelope.ts'
import {
  type AgentDelivery,
  AGENT_DELIVERY_SCHEMA,
  fitDelivery,
  isValidLabel,
} from '../src/execute/agent-delivery.ts'
import { type ExecutionDeps, createStatementRegistry } from '../src/execute/core.ts'
import { executeScript } from '../src/execute/script.ts'
import type { ScriptResponse } from '../src/execute/script.ts'
import { ownerOf } from '../src/execute/console-registry.ts'
import { createSchemaReader } from '../src/host/metadata.ts'
import type { SchemaReader } from '../src/host/metadata.ts'
import { consoleRegistryPathFor, loadConsoleRegistry } from './console-registry.ts'
import { GET_SCHEMA, LIST_TABLES, formatSchema, formatTableList } from './tools-schema.ts'
import { outboxDirFor, writeDelivery } from './agent-outbox.ts'
import { probeMysql } from './probe-mysql.ts'
import { type RuntimeSpecDocument, loadRuntimeSpecs } from './runtime-specs.ts'
import { PING_INPUT_SHAPE, PING_TOOL, ping, TOOL_NAMES } from './tools.ts'
import { LIST_DATASOURCES, TEST_CONNECTION, listDatasources, testConnection } from './tools-datasources.ts'

/** Server identity reported during MCP initialize. */
export const SERVER_INFO = { name: 'dsh-data-ide', version: '0.1.0' } as const

/** Statements per `execute_script` call; keeps one agent call from queueing a book. */
export const MAX_SCRIPT_STATEMENTS = 20

/** Rows returned to the agent across a whole `execute_script` call. */
export const MAX_AGENT_SCRIPT_ROWS = 500

/**
 * Trim script output before it reaches the model.
 *
 * The delivery keeps every statement's first page (the panel renders them); the
 * tool response is what the model must read, and 20 × 500 rows would blow the
 * context window (review §15 A9).
 */
function trimForAgent(outcome: ScriptResponse, budget: number): Record<string, unknown> {
  let left = budget
  const statements = outcome.statements.map(statement => {
    if (!statement.ok) return { ...statement }
    const rows = statement.response.rows
    const keep = Math.max(0, Math.min(rows.length, left))
    left -= keep
    if (keep === rows.length) return { ...statement }
    return {
      ...statement,
      response: { ...statement.response, rows: rows.slice(0, keep), hasNextPage: true },
      rowsTruncated: rows.length - keep,
    }
  })
  return {
    statements,
    durationMs: outcome.durationMs,
    ...(outcome.stopped === true ? { stopped: true } : {}),
  }
}

/** Argument carrying the host-published runtime spec path. */
export const SPEC_PATH_FLAG = '--dsh-data-ide-specs'

export interface ServerOptions {
  /** Absolute path to the host's runtime spec file. */
  readonly specPath?: string
  /** Pre-loaded specs; tests use this to avoid touching the filesystem. */
  readonly specs?: () => Promise<RuntimeSpecDocument>
  /** Execution transport; defaults to mysql2 over the resolved specs. */
  readonly execution?: ExecutionDeps['executor']
  /**
   * Spool directory for agent deliveries. Defaults to `agent-outbox` beside the
   * runtime spec file; tests point it at a temp dir.
   */
  readonly outboxDir?: string
  /**
   * Console-ownership snapshot published by the panel. Defaults to
   * `consoles.json` beside the spec file; tests point it at a temp file.
   */
  readonly consolesPath?: string
  /** Schema reader; defaults to the one the panel uses. Tests inject a double. */
  readonly schemaReader?: SchemaReader
}

/** Read specs, turning a missing or unreadable file into a structured tool error. */
async function readSpecsSafely(
  read: () => Promise<RuntimeSpecDocument>,
): Promise<{ ok: true; document: RuntimeSpecDocument } | { ok: false; error: { code: string; message: string } }> {
  try {
    return { ok: true, document: await read() }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'SPEC_UNAVAILABLE',
        message: `读取连接规格文件失败：${(error as Error).message}；宿主尚未发布连接，或插件刚卸载`,
      },
    }
  }
}

/** Shape a schema read failure like every other tool refusal. */
function schemaFailure(error: unknown): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: 'SCHEMA_UNAVAILABLE',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

/** Build a server instance with every tool registered. */
export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO)
  const readSpecs =
    options.specs ??
    (async () => {
      if (options.specPath === undefined) {
        throw new Error(`dsh-data-ide: MCP server started without ${SPEC_PATH_FLAG} <path>`)
      }
      return loadRuntimeSpecs(options.specPath)
    })

  const outboxDir =
    options.outboxDir ?? (options.specPath === undefined ? undefined : outboxDirFor(options.specPath))

  const consolesPath =
    options.consolesPath ??
    (options.specPath === undefined ? undefined : consoleRegistryPathFor(options.specPath))

  /**
   * Refuse to write into a console the panel says belongs to the user (§13.3).
   *
   * An unknown id is *not* a refusal: the registry may be stale, and "new
   * console" is the safe default. Only a positive "this is a user console" stops
   * the call.
   */
  async function consoleRefusal(
    consoleId: string | undefined,
  ): Promise<{ readonly code: string; readonly message: string } | null> {
    if (consoleId === undefined || consolesPath === undefined) return null
    const registry = await loadConsoleRegistry(consolesPath)
    if (ownerOf(registry, consoleId) !== 'user') return null
    return {
      code: 'CONSOLE_NOT_AGENT',
      message: `console ${consoleId} 属于用户，agent 只能写入 ai_ 控制台`,
    }
  }

  /**
   * Hand a finished execution to the panel.
   *
   * Delivery is best-effort by design: a full disk or a read-only home must not
   * turn a successful query into a failed tool call for the agent.
   */
  /** Best-effort spool write; a delivery failure never fails the tool call. */
  async function writeEnvelope(delivery: AgentDelivery): Promise<void> {
    if (outboxDir === undefined) return
    try {
      await writeDelivery(outboxDir, fitDelivery(delivery))
    } catch (error) {
      console.error(`dsh-data-ide: 结果投递失败（${(error as Error).message}）`)
    }
  }

  async function deliver(
    label: string,
    consoleId: string | undefined,
    connId: string,
    sql: string,
    result: ExecutionResult,
  ): Promise<void> {
    await writeEnvelope({
      schema: AGENT_DELIVERY_SCHEMA,
      id: randomUUID(),
      label,
      connId,
      consoleId: consoleId ?? null,
      sql,
      kind: 'single',
      at: new Date().toISOString(),
      single: result,
    })
  }

  if (TOOL_NAMES.includes(PING_TOOL)) {
    server.registerTool(
      PING_TOOL,
      {
        title: 'Ping',
        description: 'Liveness probe for the dsh-data-ide MCP server.',
        inputSchema: PING_INPUT_SHAPE,
      },
      async () => ({ content: [{ type: 'text' as const, text: JSON.stringify(ping()) }] }),
    )
  }

  if (TOOL_NAMES.includes(LIST_DATASOURCES)) {
    server.registerTool(
      LIST_DATASOURCES,
      {
        title: 'List data sources',
        description: '列出已配置的数据源（不含密码）。',
        inputSchema: PING_INPUT_SHAPE,
      },
      async () => {
        const specs = await readSpecsSafely(readSpecs)
        const result = specs.ok ? listDatasources(specs.document) : specs
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      },
    )
  }

  if (TOOL_NAMES.includes(TEST_CONNECTION)) {
    server.registerTool(
      TEST_CONNECTION,
      {
        title: 'Test connection',
        description: '测试一个数据源的连通性，返回 YES / NO / UNSURE 三态与可读原因。',
        inputSchema: { connId: z.string() },
      },
      async ({ connId }) => {
        const specs = await readSpecsSafely(readSpecs)
        const result = specs.ok ? await testConnection(specs.document, connId, probeMysql) : specs
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      },
    )
  }

  const execution: ExecutionDeps = {
    specs: readSpecs,
    executor: options.execution ?? createMysqlExecutor(),
    registry: createStatementRegistry(),
  }

  /**
   * The panel's own schema reader, resolved through the same spec document the
   * execute path uses — one source of truth for "what tables exist" (09 B1).
   */
  const schemaReader =
    options.schemaReader ??
    createSchemaReader({
      resolve: async connId => (await readSpecs()).connections[connId],
      executor: execution.executor,
    })

  if (TOOL_NAMES.includes(GET_SCHEMA)) {
    server.registerTool(
      GET_SCHEMA,
      {
        title: 'Get schema',
        description:
          '读取表结构（表/视图 + 列名与类型）。可选 table 只取一张表（`表名` 或 `库.表名`）。先用它代替 SELECT * LIMIT 1 猜列。',
        inputSchema: {
          connId: z.string(),
          table: z.string().optional(),
          refresh: z.boolean().optional(),
        },
      },
      async ({ connId, table, refresh }: { connId: string; table?: string; refresh?: boolean }) => {
        try {
          const snapshot = await schemaReader.schema(connId, refresh === true ? { refresh: true } : {})
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(formatSchema(snapshot, table)) }],
          }
        } catch (error) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(schemaFailure(error)) }] }
        }
      },
    )
  }

  if (TOOL_NAMES.includes(LIST_TABLES)) {
    server.registerTool(
      LIST_TABLES,
      {
        title: 'List tables',
        description: '只列表和视图的名字与列数（不含列明细），适合先摸清一个库里有什么。',
        inputSchema: { connId: z.string(), refresh: z.boolean().optional() },
      },
      async ({ connId, refresh }: { connId: string; refresh?: boolean }) => {
        try {
          const snapshot = await schemaReader.schema(connId, refresh === true ? { refresh: true } : {})
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(formatTableList(snapshot)) }],
          }
        } catch (error) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(schemaFailure(error)) }] }
        }
      },
    )
  }

  if (TOOL_NAMES.includes('execute_sql')) {
    server.registerTool(
      'execute_sql',
      {
        title: 'Execute SQL',
        description:
          '执行一条语句并返回首页（500+1 探针）与总行数；默认只允许 SELECT。带上 label 时结果同时投递到面板的 ai_<label> 控制台。',
        inputSchema: {
          connId: z.string(),
          sql: z.string(),
          pageSize: z.number().optional(),
          label: z.string().optional(),
          consoleId: z.string().optional(),
        },
      },
      async ({
        connId,
        sql,
        pageSize,
        label,
        consoleId,
      }: {
        connId: string
        sql: string
        pageSize?: number
        label?: string
        consoleId?: string
      }) => {
        if (label !== undefined && !isValidLabel(label)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: { code: 'BAD_LABEL', message: 'label 需为 1–64 位中文/字母/数字/_/-' },
                }),
              },
            ],
          }
        }
        const refused = await consoleRefusal(consoleId)
        if (refused !== null) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: refused }) }] }
        }
        const result = await runExecuteSql(execution, {
          connId,
          sql,
          ...(pageSize === undefined ? {} : { pageSize }),
        })
        // Only labelled runs reach the panel: an unlabelled call is the agent
        // reading data for its own reasoning and must not clutter the UI.
        if (label !== undefined) await deliver(label, consoleId, connId, sql, result)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      },
    )
  }

  if (TOOL_NAMES.includes('execute_script')) {
    server.registerTool(
      'execute_script',
      {
        title: 'Execute script',
        description:
          '按分号拆分并顺序执行整段脚本，每条语句一个结果；遇到第一条失败即停。带上 label 时投递到面板，每条语句一个结果标签。',
        inputSchema: {
          connId: z.string(),
          sql: z.string(),
          pageSize: z.number().optional(),
          maxStatements: z.number().optional(),
          label: z.string().optional(),
          consoleId: z.string().optional(),
        },
      },
      async ({
        connId,
        sql,
        pageSize,
        maxStatements,
        label,
        consoleId,
      }: {
        connId: string
        sql: string
        pageSize?: number
        maxStatements?: number
        label?: string
        consoleId?: string
      }) => {
        if (label !== undefined && !isValidLabel(label)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: { code: 'BAD_LABEL', message: 'label 需为 1–64 位中文/字母/数字/_/-' },
                }),
              },
            ],
          }
        }
        const refusedConsole = await consoleRefusal(consoleId)
        if (refusedConsole !== null) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: refusedConsole }) }],
          }
        }
        const outcome = await executeScript(execution, {
          connId,
          sql,
          ...(pageSize === undefined ? {} : { pageSize }),
          // Clamp: the cap is a contract, not a default a caller may raise
          // (review §15 A5).
          maxStatements: Math.min(maxStatements ?? MAX_SCRIPT_STATEMENTS, MAX_SCRIPT_STATEMENTS),
        })
        if ('refusal' in outcome) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: outcome.refusal }) }],
          }
        }
        if (label !== undefined) {
          await writeEnvelope({
            schema: AGENT_DELIVERY_SCHEMA,
            id: randomUUID(),
            label,
            connId,
            consoleId: consoleId ?? null,
            sql,
            kind: 'script',
            at: new Date().toISOString(),
            script: outcome.statements.map(statement => ({
              index: statement.index,
              sql: statement.sql,
              ok: statement.ok,
              ...(statement.ok
                ? { response: statement.response }
                : { error: { code: statement.error.code, message: statement.error.message } }),
            })),
          })
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true, ...trimForAgent(outcome, MAX_AGENT_SCRIPT_ROWS) }),
            },
          ],
        }
      },
    )
  }

  if (TOOL_NAMES.includes('fetch_page')) {
    server.registerTool(
      'fetch_page',
      {
        title: 'Fetch page',
        description: '翻页或跳页：LIMIT n+1 OFFSET m，不重新计数。',
        inputSchema: { connId: z.string(), sql: z.string(), offset: z.number(), pageSize: z.number().optional() },
      },
      async ({ connId, sql, offset, pageSize }: { connId: string; sql: string; offset: number; pageSize?: number }) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(await runFetchPage(execution, { connId, sql, offset, ...(pageSize === undefined ? {} : { pageSize }) })),
          },
        ],
      }),
    )
  }

  if (TOOL_NAMES.includes('cancel_statement')) {
    server.registerTool(
      'cancel_statement',
      {
        title: 'Cancel statement',
        description: '取消进行中的语句。',
        inputSchema: { statementId: z.string() },
      },
      async ({ statementId }: { statementId: string }) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(await cancelStatement(execution, statementId)) }],
      }),
    )
  }

  return server
}

/** Serve over stdio (or an injected transport) until the host closes the pipe. */
export async function main(
  transport: Transport = new StdioServerTransport(),
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const index = argv.indexOf(SPEC_PATH_FLAG)
  const specPath = index >= 0 ? argv[index + 1] : undefined
  await createServer(specPath === undefined ? {} : { specPath }).connect(transport)
}

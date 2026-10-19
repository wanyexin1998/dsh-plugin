/**
 * MCP server (stdio) shipped inside the dsh-data-ide plugin.
 *
 * The profile's bundle patch declares one `@deepseek-ai/dsh-mcp-client` instance
 * with `serverName: sql`, which spawns this file and exposes its tools to the
 * agent as `mcp__sql__*` (docs/05 §2). The server is stateless: connection
 * specs and passwords arrive through the host's runtime spec file, never from a
 * credential store of its own.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'

import { createMysqlExecutor } from '../src/execute/mysql.ts'
import { cancelStatement, runExecuteSql, runFetchPage } from '../src/execute/envelope.ts'
import { type ExecutionDeps, createStatementRegistry } from '../src/execute/core.ts'
import { probeMysql } from './probe-mysql.ts'
import { type RuntimeSpecDocument, loadRuntimeSpecs } from './runtime-specs.ts'
import { PING_INPUT_SHAPE, PING_TOOL, ping, TOOL_NAMES } from './tools.ts'
import { LIST_DATASOURCES, TEST_CONNECTION, listDatasources, testConnection } from './tools-datasources.ts'

/** Server identity reported during MCP initialize. */
export const SERVER_INFO = { name: 'dsh-data-ide', version: '0.1.0' } as const

/** Argument carrying the host-published runtime spec path. */
export const SPEC_PATH_FLAG = '--dsh-data-ide-specs'

export interface ServerOptions {
  /** Absolute path to the host's runtime spec file. */
  readonly specPath?: string
  /** Pre-loaded specs; tests use this to avoid touching the filesystem. */
  readonly specs?: () => Promise<RuntimeSpecDocument>
  /** Execution transport; defaults to mysql2 over the resolved specs. */
  readonly execution?: ExecutionDeps['executor']
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

  if (TOOL_NAMES.includes('execute_sql')) {
    server.registerTool(
      'execute_sql',
      {
        title: 'Execute SQL',
        description: '执行一条语句并返回首页（500+1 探针）与总行数；默认只允许 SELECT。',
        inputSchema: { connId: z.string(), sql: z.string(), pageSize: z.number().optional() },
      },
      async ({ connId, sql, pageSize }: { connId: string; sql: string; pageSize?: number }) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(await runExecuteSql(execution, { connId, sql, ...(pageSize === undefined ? {} : { pageSize }) })),
          },
        ],
      }),
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

import { describe, expect, it, vi } from 'vitest'

import {
  withObjects,
  createSchemaReader,
  foldSchema,
  kindsQuery,
  schemaQuery,
  toKind,
} from '../src/host/metadata.ts'
import type { QueryExecutor } from '../src/execute/core.ts'
import { createDataSource } from '../src/datasource/model.ts'

const source = { ...createDataSource({ id: 'conn-1', name: 'doris', dbms: 'doris', host: 'doris.shcell.com', username: 'u' }), database: 'dwd' }
/** Same shape the execute path hands over: a fully resolved spec. */
const spec = {
  name: source.name,
  dbms: source.dbms,
  host: source.host,
  port: source.port,
  database: 'dwd',
  username: source.username,
  password: 'p',
  driverProperties: {},
  writeEnabled: false,
} as const
const resolve = async (id: string) => (id === 'conn-1' || id === 'conn-2' ? spec : undefined)

/** Executor double returning one fixed result. */
function executorDouble(rows: unknown[][] = []) {
  const calls: { sql: string; connId: string }[] = []
  const executor: QueryExecutor = {
    query: vi.fn(async (_spec, sql, statementId) => {
      calls.push({ sql, connId: statementId })
      return { fields: [], rows }
    }),
    cancel: vi.fn(async () => undefined),
  }
  return { executor, calls }
}

describe('schemaQuery', () => {
  it('excludes system schemas and orders by ordinal position', () => {
    const sql = schemaQuery(undefined, 100)

    expect(sql).toContain('information_schema.COLUMNS')
    expect(sql).toContain("NOT IN ('information_schema'")
    expect(sql).toContain('SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE')
    expect(sql).toContain('ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION')
    expect(sql).toContain('LIMIT 100')
    expect(sql).not.toContain('TABLE_SCHEMA =')
  })

  it('restricts to the connection database and escapes quotes', () => {
    const sql = schemaQuery("o'brien", 10)

    expect(sql).toContain("AND TABLE_SCHEMA = 'o''brien'")
    expect(sql).toContain('LIMIT 10')
  })
})

describe('foldSchema', () => {
  it('groups columns per table in arrival order', () => {
    const { tables, truncated } = foldSchema([
      ['dwd_order', 'order_id', 'BIGINT'],
      ['dwd_order', 'amount', 'DECIMAL'],
      ['dwd_customer', 'customer_id', 'BIGINT'],
    ], 100)

    expect(tables).toEqual([
      { name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }, { name: 'amount', type: 'DECIMAL' }] },
      { name: 'dwd_customer', columns: [{ name: 'customer_id', type: 'BIGINT' }] },
    ])
    expect(truncated).toBe(false)
  })

  it('skips malformed rows and tolerates a missing type', () => {
    const { tables } = foldSchema([
      ['t', 'c'],
      [null, 'orphan', 'X'],
      ['t', 42, 'X'],
    ], 100)

    expect(tables).toEqual([{ name: 't', columns: [{ name: 'c', type: 'UNKNOWN' }] }])
  })

  it('reports truncation at the ceiling', () => {
    expect(foldSchema([['t', 'a', 'X'], ['t', 'b', 'X']], 2).truncated).toBe(true)
  })
})

describe('createSchemaReader', () => {
  it('reads once and serves the cache until it expires', async () => {
    const { executor, calls } = executorDouble([['dwd_order', 'order_id', 'BIGINT']])
    let clock = 0
    const reader = createSchemaReader({ resolve, executor, now: () => clock, ttlMs: 100 })

    const first = await reader.schema('conn-1')
    clock = 50
    const second = await reader.schema('conn-1')

    expect(second).toBe(first)
    // Catalogue columns plus the object kinds; both are cached together.
    expect(calls.map(call => call.sql.slice(0, 26))).toEqual([
      'SELECT TABLE_SCHEMA, TABLE',
      'SELECT TABLE_SCHEMA, TABLE',
    ])
    expect(first.tables).toEqual([{ name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }] }])
    expect(first.fetchedAt).toBe('1970-01-01T00:00:00.000Z')
    expect(first.truncated).toBe(false)
  })

  it('re-reads once the cache is stale, and on demand', async () => {
    const { executor, calls } = executorDouble([])
    let clock = 0
    const reader = createSchemaReader({ resolve, executor, now: () => clock, ttlMs: 100 })

    await reader.schema('conn-1')
    clock = 101
    await reader.schema('conn-1')
    await reader.schema('conn-1', { refresh: true })

    // Catalogue reads only: the empty answer also triggers the SHOW fallback.
    expect(calls.filter(call => !call.connId.startsWith('schema-show-'))).toHaveLength(3)
  })

  it('fails for an unknown connection', async () => {
    const { executor } = executorDouble([])
    const reader = createSchemaReader({ resolve, executor })

    await expect(reader.schema('nope')).rejects.toThrow(/连接不存在或没有可用密码/)
  })
})

describe('createSchemaReader: secrets', () => {
  it('explains a connection without a usable password', async () => {
    const { executor } = executorDouble([])
    const reader = createSchemaReader({ resolve: async () => undefined, executor })

    await expect(reader.schema('conn-1')).rejects.toThrow(/没有可用密码/)
  })

  it('probes with the spec it built, including the database', async () => {
    const { executor, calls } = executorDouble([])
    const reader = createSchemaReader({ resolve, executor })

    await reader.schema('conn-1')

    expect(calls[0]?.sql).toContain("AND TABLE_SCHEMA = 'dwd'")
  })
})

describe('createSchemaReader: connections without a database', () => {
  it('probes every schema when the connection names none', async () => {
    const { executor, calls } = executorDouble([])
    const reader = createSchemaReader({ resolve: async () => ({ ...spec, database: undefined }), executor })

    await reader.schema('conn-2')

    expect(calls[0]?.sql).not.toContain('TABLE_SCHEMA =')
  })
})

describe('SHOW fallback', () => {
  /** Executor that answers the catalogue empty and SHOW from a table map. */
  function fallbackExecutor(tables: Record<string, string[]>) {
    const calls: string[] = []
    const executor: QueryExecutor = {
      query: vi.fn(async (_spec, sql) => {
        calls.push(sql)
        if (sql.startsWith('SHOW FULL TABLES')) {
          return { fields: [], rows: Object.entries(tables).map(([name, columns]) => [name, columns[0] === 'VIEW' ? 'VIEW' : 'BASE TABLE']) }
        }
        if (sql.startsWith('SHOW FULL COLUMNS')) {
          const name = sql.split('.').pop()?.replace(/`/g, '') ?? ''
          return { fields: [], rows: (tables[name] ?? []).map(column => [column, 'VARCHAR']) }
        }
        return { fields: [], rows: [] }
      }),
      cancel: vi.fn(async () => undefined),
    }
    return { executor, calls }
  }

  it('lists tables and columns when the catalogue is not readable', async () => {
    const { executor } = fallbackExecutor({ dwd_order: ['order_id', 'amount'] })
    const reader = createSchemaReader({ resolve, executor })

    const snapshot = await reader.schema('conn-1')

    expect(snapshot.source).toBe('show')
    expect(snapshot.tables).toEqual([{
      name: 'dwd_order',
      schema: 'dwd',
      kind: 'table',
      columns: [{ name: 'order_id', type: 'VARCHAR' }, { name: 'amount', type: 'VARCHAR' }],
    }])
  })

  it('notes when the fallback stops at its ceiling', async () => {
    const { executor } = fallbackExecutor({ a: ['x'], b: ['y'] })
    const reader = createSchemaReader({ resolve, executor, showTables: 1 })

    const snapshot = await reader.schema('conn-1')

    expect(snapshot.truncated).toBe(true)
    expect(snapshot.note).toContain('前 1 张表')
    expect(snapshot.tables).toHaveLength(1)
  })

  it('explains a fallback failure and an empty schema', async () => {
    const failing: QueryExecutor = {
      query: vi.fn(async (_spec, sql) => {
        if (sql.startsWith('SHOW')) throw new Error('denied')
        return { fields: [], rows: [] }
      }),
      cancel: vi.fn(async () => undefined),
    }
    const broken = await createSchemaReader({ resolve, executor: failing }).schema('conn-1')
    expect(broken.note).toContain('SHOW 回退失败')

    const empty = await createSchemaReader({ resolve, executor: executorDouble([]).executor }).schema('conn-1')
    expect(empty.note).toContain('缺少 SELECT 授权')
  })

  it('skips SHOW when the connection names no database', async () => {
    const { executor, calls } = executorDouble([])
    const reader = createSchemaReader({
      resolve: async () => ({ ...spec, database: undefined }),
      executor,
    })

    const snapshot = await reader.schema('conn-2')

    expect(calls.some(call => call.sql.startsWith('SHOW'))).toBe(false)
    expect(snapshot.note).toContain('缺少 SELECT 授权')
  })
})

describe('SHOW fallback: sparse rows', () => {
  it('tolerates a column row without a type and drops an unnamed one', async () => {
    const executor: QueryExecutor = {
      query: vi.fn(async (_spec, sql) => {
        if (sql.startsWith('SHOW FULL TABLES')) throw new Error('doris has no SHOW FULL TABLES')
        if (sql.startsWith('SHOW TABLES')) return { fields: [], rows: [['t']] }
        return { fields: [], rows: [['c1'], []] }
      }),
      cancel: vi.fn(async () => undefined),
    }
    const reader = createSchemaReader({ resolve, executor })

    const snapshot = await reader.schema('conn-1')

    // `SHOW FULL TABLES` failed, so the kind is unknown but the schema is known.
    expect(snapshot.tables).toEqual([{ name: 't', schema: 'dwd', columns: [{ name: 'c1', type: 'UNKNOWN' }] }])
  })
})

describe('object kinds', () => {
  /** Executor that answers COLUMNS and TABLES separately, from fixtures. */
  function catalogueExecutor(options: {
    columns: unknown[][]
    kinds?: unknown[][]
    kindsError?: string
  }) {
    const calls: string[] = []
    const executor: QueryExecutor = {
      query: vi.fn(async (_spec, sql) => {
        calls.push(sql)
        if (sql.includes('information_schema.TABLES')) {
          if (options.kindsError !== undefined) throw new Error(options.kindsError)
          return { fields: [], rows: options.kinds ?? [] }
        }
        return { fields: [], rows: options.columns }
      }),
      cancel: vi.fn(async () => undefined),
    }
    return { executor, calls }
  }

  it('excludes system schemas and honours the database filter', () => {
    const sql = kindsQuery(undefined)
    expect(sql).toContain('information_schema.TABLES')
    expect(sql).toContain("NOT IN ('information_schema'")
    expect(sql).not.toContain('TABLE_SCHEMA =')

    expect(kindsQuery('dwd')).toContain("AND TABLE_SCHEMA = 'dwd'")
  })

  it('maps TABLE_TYPE onto the two kinds the tree renders', () => {
    expect(toKind('BASE TABLE')).toBe('table')
    expect(toKind('VIEW')).toBe('view')
    expect(toKind('SYSTEM VIEW')).toBe('view')
    expect(toKind(null)).toBe('table')
  })

  it('adds objects that have no column rows (views) and their kinds', () => {
    const folded = foldSchema([
      ['dwd', 'dwd_order', 'order_id', 'BIGINT'],
      ['dwd', 'v_daily', 'day', 'DATE'],
    ], 100)
    const table = withObjects(folded.tables, [
      ['dwd', 'dwd_order', 'BASE TABLE'],
      ['dwd', 'v_daily', 'VIEW'],
      // Doris reports no columns for a view, so this object exists only here.
      ['dwd', 'dwd_trade_order_all_v', 'VIEW'],
      ['ods_db', 'ods_hr_emp_ai_v', 'VIEW'],
      [null, 'ghost', 'VIEW'],
    ])

    expect(table.map(entry => `${entry.schema ?? ''}.${entry.name}:${entry.kind ?? ''}`)).toEqual([
      'dwd.dwd_order:table',
      'dwd.dwd_trade_order_all_v:view',
      'dwd.v_daily:view',
      'ods_db.ods_hr_emp_ai_v:view',
      // An unnamed schema sorts last, after the real databases.
      '.ghost:view',
    ])
    // The view keeps its place with no columns; the tree shows it as empty.
    expect(table.find(entry => entry.name === 'dwd_trade_order_all_v')?.columns).toEqual([])
  })

  it('ignores a TABLES row that carries no usable name or type', () => {
    const folded = foldSchema([['dwd', 't', 'c', 'INT']], 10)
    const merged = withObjects(folded.tables, [
      ['dwd', 42, 'VIEW'],
      ['dwd', '', 'VIEW'],
      // A mis-shaped answer must not invent objects (the third cell is the type).
      ['dwd', 'looks_like_a_table', 'BIGINT'],
    ])
    expect(merged.map(entry => entry.name)).toEqual(['t'])
  })

  it('reads kinds through the reader so the tree can split tables from views', async () => {
    const { executor, calls } = catalogueExecutor({
      columns: [
        ['dwd', 'dwd_order', 'order_id', 'BIGINT'],
        ['dwd', 'v_daily', 'day', 'DATE'],
      ],
      kinds: [
        ['dwd', 'dwd_order', 'BASE TABLE'],
        ['dwd', 'v_daily', 'VIEW'],
      ],
    })
    const reader = createSchemaReader({ resolve, executor })

    const snapshot = await reader.schema('conn-1')

    expect(snapshot.tables).toEqual([
      { name: 'dwd_order', schema: 'dwd', columns: [{ name: 'order_id', type: 'BIGINT' }], kind: 'table' },
      { name: 'v_daily', schema: 'dwd', columns: [{ name: 'day', type: 'DATE' }], kind: 'view' },
    ])
    expect(calls.some(call => call.includes('information_schema.TABLES'))).toBe(true)
    expect(snapshot.note).toBeUndefined()
  })

  it('keeps the columns when the kinds read is refused', async () => {
    const { executor } = catalogueExecutor({
      columns: [['dwd', 'dwd_order', 'order_id', 'BIGINT']],
      kindsError: 'denied',
    })
    const reader = createSchemaReader({ resolve, executor })

    const snapshot = await reader.schema('conn-1')

    expect(snapshot.tables).toEqual([{ name: 'dwd_order', schema: 'dwd', columns: [{ name: 'order_id', type: 'BIGINT' }] }])
    expect(snapshot.note).toContain('表与视图暂不分组')
  })
})

describe('object kinds: sparse rows', () => {
  it('skips an unnamed kind row and an unnamed SHOW FULL row', async () => {
    // `withObjects` tolerates a row whose name is not a string.
    const folded = foldSchema([['dwd', 't', 'c', 'INT']], 10)
    expect(withObjects(folded.tables, [['dwd', 42, 'VIEW']]).map(entry => entry.name)).toEqual(['t'])

    // And so does the SHOW FULL TABLES reader.
    const executor: QueryExecutor = {
      query: vi.fn(async (_spec, sql) => {
        if (sql.startsWith('SHOW FULL TABLES')) return { fields: [], rows: [[42, 'BASE TABLE'], ['v', 'VIEW']] }
        if (sql.startsWith('SHOW FULL COLUMNS')) return { fields: [], rows: [['c', 'INT']] }
        return { fields: [], rows: [] }
      }),
      cancel: vi.fn(async () => undefined),
    }
    const snapshot = await createSchemaReader({ resolve, executor }).schema('conn-1')

    expect(snapshot.tables).toEqual([{ name: 'v', schema: 'dwd', kind: 'view', columns: [{ name: 'c', type: 'INT' }] }])
  })
})

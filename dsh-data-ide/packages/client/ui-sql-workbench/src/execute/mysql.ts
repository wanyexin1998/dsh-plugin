/**
 * mysql2 implementation of the execution port.
 *
 * One connection per statement keeps cancellation honest: `cancel` destroys the
 * socket the statement runs on, which is the only reliable abort a MySQL
 * protocol driver offers mid-query (DataGrip gives up and closes the backend
 * session for the same reason).
 *
 * Doris/MySQL speak the same wire protocol, so one adapter serves both
 * (docs/02 §4).
 */

import { createConnection } from 'mysql2/promise'
import type { Connection } from 'mysql2/promise'

import type { ConnectionSpec } from '../host/runtime-specs.ts'
import type { QueryExecutor, QueryResult } from './core.ts'

/**
 * Wire type code → type name.
 *
 * Mirrors `mysql2/lib/constants/types.js`. Kept local because mysql2 ships no
 * declaration for its `Types` table, and the grid only needs the name for
 * formatting decisions (docs/03 §6.5).
 */
const TYPE_NAMES: Record<number, string> = {
  0x00: 'DECIMAL',
  0x01: 'TINY',
  0x02: 'SHORT',
  0x03: 'LONG',
  0x04: 'FLOAT',
  0x05: 'DOUBLE',
  0x06: 'NULL',
  0x07: 'TIMESTAMP',
  0x08: 'LONGLONG',
  0x09: 'INT24',
  0x0a: 'DATE',
  0x0b: 'TIME',
  0x0c: 'DATETIME',
  0x0d: 'YEAR',
  0x0e: 'NEWDATE',
  0x0f: 'VARCHAR',
  0x10: 'BIT',
  0xf2: 'VECTOR',
  0xf5: 'JSON',
  0xf6: 'NEWDECIMAL',
  0xf7: 'ENUM',
  0xf8: 'SET',
  0xf9: 'TINY_BLOB',
  0xfa: 'MEDIUM_BLOB',
  0xfb: 'LONG_BLOB',
  0xfc: 'BLOB',
  0xfd: 'VAR_STRING',
  0xfe: 'STRING',
  0xff: 'GEOMETRY',
}

/** One raw field as the driver reports it; only two members matter to us. */
interface RawField {
  readonly name?: unknown
  readonly type?: unknown
}

/** Open sockets keyed by statement id, so a cancel can destroy the right one. */
export function createMysqlExecutor(): QueryExecutor {
  const open = new Map<string, Connection>()

  return {
    async query(spec, sql, statementId): Promise<QueryResult> {
      const connection = await createConnection({
        host: spec.host,
        port: spec.port,
        user: spec.username,
        password: spec.password,
        database: spec.database,
        connectTimeout: 10_000,
        ...spec.driverProperties,
      })
      open.set(statementId, connection)
      try {
        const [rawRows, rawFields] = await connection.query(sql)
        // mysql2 hands back row objects keyed by column; the grid wants values
        // in the column order the driver reported.
        const fields = ((rawFields as RawField[] | undefined) ?? []).map(field => ({
          name: String(field.name ?? ''),
          typeName: typeof field.type === 'number' ? (TYPE_NAMES[field.type] ?? 'UNKNOWN') : 'UNKNOWN',
        }))
        return {
          fields,
          rows: (rawRows as Record<string, unknown>[]).map(row => fields.map(field => row[field.name] ?? null)),
        }
      } finally {
        open.delete(statementId)
        await connection.end().catch(() => undefined)
      }
    },

    async cancel(statementId): Promise<void> {
      const connection = open.get(statementId)
      if (connection === undefined) return
      // Destroy rather than end: an in-flight statement must stop now.
      await connection.destroy()
    },
  }
}

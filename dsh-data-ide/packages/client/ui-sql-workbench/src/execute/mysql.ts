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

/** A socket that is open, still connecting, or already asked to stop. */
type LiveSocket = Connection | 'pending' | 'cancelled'

/** OkPacket / ResultSetHeader: a write acknowledgement, not a row list. */
function isResultHeader(value: unknown): value is { affectedRows?: number; insertId?: number; warningStatus?: number } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Open sockets keyed by statement id, so a cancel can destroy the right one. */
export function createMysqlExecutor(): QueryExecutor {
  const open = new Map<string, LiveSocket>()

  return {
    async query(spec, sql, statementId): Promise<QueryResult> {
      // Register before connect so a cancel during the handshake is not a lie.
      if (open.get(statementId) === 'cancelled') throw new Error('查询已取消')
      open.set(statementId, 'pending')
      let connection: Connection
      try {
        connection = await createConnection({
          host: spec.host,
          port: spec.port,
          user: spec.username,
          password: spec.password,
          database: spec.database,
          connectTimeout: 10_000,
          ...spec.driverProperties,
          // Arrays keep duplicate column names (`a.id`, `b.id`) distinct.
          // A row object would collapse them onto one key.
          rowsAsArray: true,
        })
      } catch (error) {
        open.delete(statementId)
        throw error
      }
      if (open.get(statementId) === 'cancelled') {
        open.delete(statementId)
        try {
          await connection.destroy()
        } catch {
          // The socket is already gone; the query still must not return rows.
        }
        throw new Error('查询已取消')
      }
      open.set(statementId, connection)
      try {
        const [rawRows, rawFields] = await connection.query(sql)
        const fields = ((rawFields as RawField[] | undefined) ?? []).map(field => ({
          name: String(field.name ?? ''),
          typeName: typeof field.type === 'number' ? (TYPE_NAMES[field.type] ?? 'UNKNOWN') : 'UNKNOWN',
        }))
        // INSERT/UPDATE/DELETE resolve to an OkPacket after the server has
        // committed. Mapping that object as rows throws, and the UI then
        // reports a failure for a write that already landed.
        if (isResultHeader(rawRows)) {
          return {
            fields: [
              { name: 'affectedRows', typeName: 'LONGLONG' },
              { name: 'insertId', typeName: 'LONGLONG' },
              { name: 'warningStatus', typeName: 'LONG' },
            ],
            rows: [[
              Number(rawRows.affectedRows ?? 0),
              Number(rawRows.insertId ?? 0),
              Number(rawRows.warningStatus ?? 0),
            ]],
          }
        }
        const table = rawRows as readonly (readonly unknown[])[]
        return {
          fields,
          rows: table.map(row => fields.map((_, index) => row[index] ?? null)),
        }
      } finally {
        open.delete(statementId)
        await connection.end().catch(() => undefined)
      }
    },

    async cancel(statementId): Promise<boolean> {
      const current = open.get(statementId)
      if (current === undefined) return false
      if (current === 'cancelled') return true
      if (current === 'pending') {
        open.set(statementId, 'cancelled')
        return true
      }
      open.delete(statementId)
      // Destroy rather than end: an in-flight statement must stop now.
      await current.destroy()
      return true
    },
  }
}

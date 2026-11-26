/**
 * Real probe over mysql2, shared by Doris and MySQL (both speak the MySQL wire
 * protocol; Doris answers on 9030 — RUNTIME-FINDINGS §2.2).
 *
 * Connection-test budget is 3s end to end (AC-1), so the driver gets a slightly
 * smaller budget and the version probe runs after `SELECT 1`.
 */

import { createRequire } from 'node:module'

import { createConnection } from 'mysql2/promise'

import type { ConnectionSpec } from '../src/host/runtime-specs.ts'
import type { DatabaseInfo } from '../src/datasource/model.ts'
import { type ConnectionProbe, type ProbeOutcome, classifyProbeError, probeVerdict } from './probe.ts'

/**
 * Driver version reported in `database-info`.
 *
 * @param load - Manifest reader; injected so the fallback path is testable.
 */
export function resolveDriverVersion(
  load: () => unknown = () => createRequire(import.meta.url)('mysql2/package.json').version,
): string {
  try {
    return `mysql2 ${String(load())}`
  } catch {
    return 'mysql2'
  }
}

const driverVersion = resolveDriverVersion()

/** Connect, prove liveness, then read product facts. */
export const probeMysql: ConnectionProbe = async spec => {
  let connection: Awaited<ReturnType<typeof createConnection>>
  try {
    connection = await createConnection({
      host: spec.host,
      port: spec.port,
      user: spec.username,
      password: spec.password,
      database: spec.database,
      connectTimeout: 2500,
      ...spec.driverProperties,
    })
  } catch (error) {
    const classified = classifyProbeError(error)
    return { state: probeVerdict(classified), error: classified }
  }

  const outcome = await probeConnection(connection)
  await closeQuietly(connection.end)
  return outcome
}

/** Prove liveness, then read the product facts DataGrip caches. */
async function probeConnection(connection: Awaited<ReturnType<typeof createConnection>>): Promise<ProbeOutcome> {
  try {
    await connection.query('SELECT 1')
  } catch (error) {
    const classified = classifyProbeError(error)
    return { state: probeVerdict(classified), error: classified }
  }
  // `SELECT 1` already proved the session. A missing `version()` is still YES.
  return { state: 'YES', info: await readDatabaseInfo(connection) }
}

/**
 * Close the socket without letting a close failure mask the probe's own verdict.
 *
 * @param end - Driver close function.
 */
export async function closeQuietly(end: () => Promise<void>): Promise<void> {
  try {
    await end()
  } catch {
    // The probe already reported the real failure; a failing close adds nothing.
  }
}

/**
 * Read the product facts DataGrip caches in `database-info`.
 *
 * Every optional variable is best-effort: Doris rejects `@@default_authentication_plugin`
 * with errCode 1193 (RUNTIME-FINDINGS §3b), so a missing variable must not fail a probe.
 */
const LOWER_CASE_TABLE_NAMES = new Set(['1', '2'])

/** `0` is case-sensitive. `1` and `2` fold plain identifiers to lower case. */
function caseFoldingOf(value: string): 'exact' | 'lower' {
  return LOWER_CASE_TABLE_NAMES.has(value) ? 'lower' : 'exact'
}

/** `sql_mode` is a comma list; `ANSI_QUOTES` may sit beside other modes. */
function quoteOf(mode: string): '"' | '`' {
  return mode.split(',').some(part => part.trim() === 'ANSI_QUOTES') ? '"' : '`'
}

async function readDatabaseInfo(connection: Awaited<ReturnType<typeof createConnection>>): Promise<DatabaseInfo> {
  let version = ''
  let comment = ''
  try {
    const [rows] = await connection.query('SELECT version() AS version, @@version_comment AS comment')
    const row = (rows as Record<string, unknown>[])[0] ?? {}
    version = typeof row['version'] === 'string' ? row['version'] : ''
    comment = typeof row['comment'] === 'string' ? row['comment'] : ''
  } catch {
    // The liveness query already succeeded. Product facts are best-effort.
  }

  const identifierQuoteString = await bestEffort(connection, 'SELECT @@session.sql_mode AS mode').then(quoteOf)
  const caseFolding = await bestEffort(connection, 'SELECT @@lower_case_table_names AS lctn')

  return {
    product: /doris/i.test(comment) ? 'Doris' : 'MySQL',
    version,
    driverVersion,
    dbms: 'MYSQL',
    ...(comment === '' ? {} : { exactVersion: comment }),
    identifierQuoteString,
    caseSensitivity: { plain: caseFoldingOf(caseFolding), quoted: 'exact' },
  }
}

/** Run an optional probe query, defaulting when the server rejects it. */
async function bestEffort(connection: Awaited<ReturnType<typeof createConnection>>, sql: string): Promise<string> {
  try {
    const [rows] = await connection.query(sql)
    const row = (rows as Record<string, unknown>[])[0] ?? {}
    const value = Object.values(row)[0]
    return value === undefined || value === null ? '' : String(value)
  } catch {
    return ''
  }
}

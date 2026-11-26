/**
 * Schema migrations with a guaranteed rollback path (E01-01, AT-36).
 *
 * Frozen rules (03§05, 03§06):
 *  - every migration runs behind one consistent backup;
 *  - a failed migration leaves the previous schema readable and the schema
 *    version unchanged — the ledger never half-upgrades;
 *  - the version is stored in `meta`, never inferred from the file.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { snapshotBackup, verifyDatabase, type BoopDatabase } from './database.ts'
import { SCHEMA_VERSION } from './schema.ts'

export interface MigrationStep {
  version: number
  name: string
  /** SQL executed inside one transaction. */
  sql: string
}

export interface MigrationReport {
  from: number | null
  to: number
  applied: number[]
  skipped: number[]
  backupPath: string | null
  /** SHA-256 of the pre-migration snapshot. Null when no upgrade ran. */
  backupSha256: string | null
  /** Row counts captured before the upgrade, from the live ledger. */
  counts: Record<string, number> | null
  integrity: 'ok' | 'failed'
  /** Set when this build must not write the ledger. No migration is attempted. */
  refused: 'future-schema' | null
}

export interface MigrateOptions {
  backupDir?: string
  backupName?: string
  /** Test hook. Production uses {@link MIGRATIONS}. */
  steps?: readonly MigrationStep[]
  /** Test hook. Production uses {@link SCHEMA_VERSION}. */
  target?: number
}

export const MIGRATIONS: MigrationStep[] = [
  {
    version: 1,
    name: 'core-ledger',
    sql: '', // the core DDL is applied by BoopDatabase.bootstrap()
  },
]

const COUNTED_TABLES = ['scopes', 'task', 'action', 'command_outbox', 'fact', 'approval'] as const

function emptyReport(from: number | null, target: number, steps: readonly MigrationStep[], extra: Partial<MigrationReport> = {}): MigrationReport {
  return {
    from,
    to: target,
    applied: [],
    skipped: steps.map((step) => step.version),
    backupPath: null,
    backupSha256: null,
    counts: null,
    integrity: 'ok',
    refused: null,
    ...extra,
  }
}

function tableCounts(db: BoopDatabase): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const table of COUNTED_TABLES) {
    const exists = db.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { ok: number }
      | undefined
    if (!exists) continue
    const row = db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    counts[table] = Number(row.n)
  }
  return counts
}

/**
 * Advance the ledger to `target`. Same-version opens do not write.
 * An upgrade snapshots first and applies every pending step plus the new
 * version in one transaction. Backup or SQL failure leaves the previous
 * version in place. A newer ledger is refused without a write.
 */
export function migrate(db: BoopDatabase, options: MigrateOptions = {}): MigrationReport {
  const from = db.schemaVersion()
  const steps = options.steps ?? MIGRATIONS
  const target = options.target ?? SCHEMA_VERSION
  if (from !== null && from > target) {
    return emptyReport(from, target, steps, { refused: 'future-schema' })
  }
  const pending = steps.filter((step) => step.version > (from ?? 0) && step.version <= target)
  if (from !== null && from === target) return emptyReport(from, target, steps)
  if (pending.length === 0) return emptyReport(from, target, steps)

  if (!options.backupDir) {
    throw new Error('boop: migration requires a backup directory')
  }
  mkdirSync(options.backupDir, { recursive: true })
  const backupPath = join(options.backupDir, options.backupName ?? `boop-pre-v${target}.sqlite`)
  snapshotBackup(db, backupPath)
  const backupCheck = verifyDatabase(backupPath)
  if (!backupCheck.ok) {
    throw new Error(`boop: pre-migration backup failed integrity check: ${backupCheck.integrity}`)
  }
  const counts = tableCounts(db)
  const backupSha256 = createHash('sha256').update(readFileSync(backupPath)).digest('hex')

  db.writeSync(() => {
    for (const step of pending) {
      if (step.sql.trim() === '') continue
      db.db.exec(step.sql)
    }
    db.db
      .prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('schema_version', String(target))
  })

  const integrity = verifyDatabase(db.path)
  return {
    from,
    to: db.schemaVersion() ?? target,
    applied: pending.map((step) => step.version),
    skipped: steps.filter((step) => !pending.includes(step)).map((step) => step.version),
    backupPath,
    backupSha256,
    counts,
    integrity: integrity.ok ? 'ok' : 'failed',
    refused: null,
  }
}
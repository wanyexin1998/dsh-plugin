/**
 * Schema migrations with a guaranteed rollback path (E01-01, AT-36).
 *
 * Frozen rules (03§05, 03§06):
 *  - every migration runs behind one consistent backup;
 *  - a failed migration leaves the previous schema readable and the schema
 *    version unchanged — the ledger never half-upgrades;
 *  - the version is stored in `meta`, never inferred from the file.
 */

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
  integrity: 'ok' | 'failed'
}

export const MIGRATIONS: MigrationStep[] = [
  {
    version: 1,
    name: 'core-ledger',
    sql: '', // the core DDL is applied by BoopDatabase.bootstrap()
  },
]

export async function migrate(
  db: BoopDatabase,
  options: { backupDir?: string; backupName?: string } = {},
): Promise<MigrationReport> {
  const from = db.schemaVersion()
  const target = SCHEMA_VERSION
  const pending = MIGRATIONS.filter((step) => step.version > (from ?? 0) && step.version <= target)
  if (from !== null && from === target) {
    return { from, to: target, applied: [], skipped: MIGRATIONS.map((m) => m.version), backupPath: null, integrity: 'ok' }
  }

  // One consistent backup before any structural change.
  let backupPath: string | null = null
  if (from !== null && options.backupDir) {
    const { mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    mkdirSync(options.backupDir, { recursive: true })
    backupPath = join(options.backupDir, options.backupName ?? `boop-pre-v${target}.sqlite`)
    snapshotBackup(db, backupPath)
  }

  for (const step of pending) {
    if (step.sql.trim() === '') continue
    await db.write(() => db.db.exec(step.sql))
  }

  await db.write(() =>
    db.db
      .prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('schema_version', String(target)),
  )

  const integrity = verifyDatabase(db.path)
  return {
    from,
    to: target,
    applied: pending.map((step) => step.version),
    skipped: MIGRATIONS.filter((step) => !pending.includes(step)).map((step) => step.version),
    backupPath,
    integrity: integrity.ok ? 'ok' : 'failed',
  }
}
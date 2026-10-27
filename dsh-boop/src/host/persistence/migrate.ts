/**
 * Schema migrations with a guaranteed rollback path (E01-01, AT-36).
 *
 * Frozen rules (03§05, 03§06):
 *  - every migration runs behind one consistent backup;
 *  - a failed migration leaves the previous schema readable and the schema
 *    version unchanged — the ledger never half-upgrades;
 *  - the version is stored in `meta`, never inferred from the file.
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { snapshotBackup, verifyDatabase, type BoopDatabase } from './database.ts'
import { CORE_DDL, SCHEMA_VERSION } from './schema.ts'
import { applySchemaV2 } from './schema-v2.ts'

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

export function migrate(
  db: BoopDatabase,
  options: { backupDir?: string; backupName?: string } = {},
): MigrationReport {
  const inspection = db.inspect()
  if (inspection.kind === 'corrupt') throw new Error(`MIGRATION_FAILED: ${inspection.reason}`)
  if (inspection.kind === 'unsupported') throw new Error(`VERSION_UNSUPPORTED: ${inspection.version}`)
  const from = inspection.kind === 'empty' ? null : inspection.version
  const target = SCHEMA_VERSION
  if (from === target) {
    return { from, to: target, applied: [], skipped: [1, 2], backupPath: null, integrity: 'ok' }
  }
  if (from !== null && from > target) throw new Error(`VERSION_UNSUPPORTED: ${from}`)

  // A consistent backup is required before any structural change of an existing ledger.
  // Copying a live WAL file by hand is not a backup. Empty initialization already
  // happened in bootstrap and does not reach here with business rows.
  let backupPath: string | null = null
  if (from !== null) {
    if (!options.backupDir) throw new Error('MIGRATION_FAILED: a consistent backup directory is required')
    mkdirSync(options.backupDir, { recursive: true })
    backupPath = path.join(options.backupDir, options.backupName ?? `boop-pre-v${target}-${Date.now()}.sqlite`)
    snapshotBackup(db, backupPath)
    const backup = verifyDatabase(backupPath)
    if (!backup.ok) throw new Error('MIGRATION_FAILED: backup failed integrity check')
  }

  const now = new Date().toISOString()
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const again = db.schemaVersion()
    if (from === null) db.db.exec(CORE_DDL)
    else if (again !== from) throw new Error('MIGRATION_FAILED: schema version changed before the upgrade transaction')
    applySchemaV2(db.db as unknown as Parameters<typeof applySchemaV2>[0], now)
    const fk = db.db.prepare('PRAGMA foreign_key_check').all() as unknown[]
    if (fk.length > 0) throw new Error('MIGRATION_FAILED: foreign_key_check failed')
    db.db
      .prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('schema_version', String(target))
    db.db.prepare('UPDATE scopes SET schema_version = ?').run(target)
    db.db
      .prepare(
        `INSERT INTO audit_event(id,scope_id,time,actor,kind,object_id,reason)
         SELECT 'mig-' || scope_id || '-' || ?, scope_id, ?, 'system', 'schema/migrated', NULL, ? FROM scopes`,
      )
      .run(String(target), now, `from=${from ?? 'empty'}`)
    db.db.exec('COMMIT')
  } catch (error) {
    try {
      db.db.exec('ROLLBACK')
    } catch {
      /* keep the original error */
    }
    throw error
  }

  const integrity = verifyDatabase(db.path)
  if (!integrity.ok || db.schemaVersion() !== target) {
    throw new Error('MIGRATION_FAILED: post-commit readback failed')
  }
  return {
    from,
    to: target,
    applied: [target],
    skipped: [],
    backupPath,
    integrity: 'ok',
  }
}
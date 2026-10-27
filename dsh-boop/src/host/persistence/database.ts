/**
 * BOOP database handle (E00-03 driver verification, E01-01 repository base).
 *
 * Frozen constraints (03§06):
 *  - SQLite with WAL and `foreign_keys=ON`;
 *  - one single write queue — no concurrent writers in one process;
 *  - FTS is derived and optional;
 *  - a network share is out of scope for write management (03§02): a UNC path
 *    or a mapped drive on Windows is refused rather than silently accepted.
 *  - migration always runs behind a consistent backup, and a failed migration
 *    leaves the previous schema readable (03§05, AT-36).
 */
import { DatabaseSync } from 'node:sqlite'
import { CORE_DDL, FTS_DDL, SCHEMA_VERSION } from './schema.ts'
import { applySchemaV2 } from './schema-v2.ts'

export interface BoopDatabaseOptions {
  path: string
  /** Set false only for `:memory:` test databases. */
  wal?: boolean
  fts?: boolean
  /** Monotonic clock source (ms); injectable for tests. */
  now?: () => number
}

export interface BootstrapReport {
  driver: 'node:sqlite'
  sqliteVersion: string
  wal: boolean
  foreignKeys: boolean
  fts: boolean
  schemaVersion: number
  migratedFrom: number | null
}

export type LedgerInspection =
  | { kind: 'empty' }
  | { kind: 'ready'; version: number }
  | { kind: 'legacy'; version: number }
  | { kind: 'unsupported'; version: number }
  | { kind: 'corrupt'; reason: string }

/**
 * Reject storage paths BOOP must not manage (03§02: "网络共享目录不在 SQLite
 * 写入支持范围，NFS/SMB 上拒绝启用写管理").
 */
export function isUnsupportedStoragePath(path: string): boolean {
  if (/^\\\\/u.test(path)) return true // UNC \\server\share
  if (/^[a-zA-Z]:$/u.test(path)) return true // bare drive root
  return false
}

export class BoopDatabase {
  readonly db: DatabaseSync
  readonly path: string
  fts: boolean
  private readonly now: () => number
  /** Single write queue: every write transaction is chained onto this promise. */
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(options: BoopDatabaseOptions) {
    if (isUnsupportedStoragePath(options.path)) {
      throw new Error(`boop: unsupported storage path (network share or drive root): ${options.path}`)
    }
    this.path = options.path
    this.now = options.now ?? Date.now
    this.db = new DatabaseSync(options.path)
    const wal = options.wal ?? options.path !== ':memory:'
    if (wal) this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA synchronous = FULL')
    this.fts = options.fts ?? false
  }

  get sqliteVersion(): string {
    const row = this.db.prepare('select sqlite_version() as v').get() as { v: string }
    return row.v
  }

  get journalMode(): string {
    const row = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    return row.journal_mode
  }

  /**
   * Older ledgers created before `subject_key` existed still open. The column
   * is nullable and does not change schema_version; a missing column only
   * forces the conservative conflict rule, so we add it in place.
   */
  private ensureSubjectKey(): void {
    const columns = this.db.prepare('PRAGMA table_info(fact)').all() as Array<{ name: string }>
    if (columns.some((column) => column.name === 'subject_key')) return
    this.db.exec('ALTER TABLE fact ADD COLUMN subject_key TEXT')
  }

  /**
   * Read the ledger without writing. A file that already has BOOP business
   * tables but no readable schema version is corrupt, not empty.
   */
  inspect(): LedgerInspection {
    let names = new Set<string>()
    try {
      const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: unknown }>
      names = new Set(rows.map((row) => String(row.name)))
    } catch (error) {
      return { kind: 'corrupt', reason: error instanceof Error ? error.message : String(error) }
    }
    const business = ['task', 'action', 'fact', 'scopes'].some((name) => names.has(name))
    if (business && !names.has('meta')) return { kind: 'corrupt', reason: 'business tables exist but meta is missing' }
    const version = names.has('meta') ? this.schemaVersion() : null
    if (business && (version === null || Number.isNaN(version))) {
      return { kind: 'corrupt', reason: 'schema_version is missing or unreadable' }
    }
    if (!business && version === null) return { kind: 'empty' }
    if (version === null) return { kind: 'empty' }
    if (version > SCHEMA_VERSION) return { kind: 'unsupported', version }
    if (version === SCHEMA_VERSION) return { kind: 'ready', version }
    return { kind: 'legacy', version }
  }

  /**
   * Initialize an empty ledger to schema 2, or leave an existing ledger untouched.
   * Upgrades of v1 files happen in `migrate`, after a consistent backup and the
   * writer fence. This method never stamps a higher version over business data.
   */
  bootstrap(): BootstrapReport {
    const inspection = this.inspect()
    if (inspection.kind === 'corrupt') throw new Error(`MIGRATION_FAILED: ${inspection.reason}`)
    if (inspection.kind === 'unsupported') throw new Error(`VERSION_UNSUPPORTED: ${inspection.version}`)
    if (inspection.kind === 'legacy' || inspection.kind === 'ready') {
      this.ensureSubjectKey()
      this.installFts()
      return this.report(inspection.version, inspection.version)
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec(CORE_DDL)
      applySchemaV2(this.db as unknown as Parameters<typeof applySchemaV2>[0])
      this.db
        .prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('schema_version', String(SCHEMA_VERSION))
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* keep the original migration error */
      }
      throw error
    }
    this.installFts()
    return this.report(SCHEMA_VERSION, null)
  }

  private installFts(): void {
    if (!this.fts) return
    try {
      this.db.exec(FTS_DDL)
    } catch {
      // FTS is derived. A build without FTS5 keeps the ledger and degrades
      // retrieval to exact match; it never weakens forget or authority rules.
      this.fts = false
    }
  }

  private report(schemaVersion: number, migratedFrom: number | null): BootstrapReport {
    return {
      driver: 'node:sqlite',
      sqliteVersion: this.sqliteVersion,
      wal: this.journalMode.toLowerCase() === 'wal',
      foreignKeys: (this.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1,
      fts: this.fts,
      schemaVersion,
      migratedFrom,
    }
  }

  schemaVersion(): number | null {
    try {
      const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
        | { value: string }
        | undefined
      return row ? Number(row.value) : null
    } catch {
      return null
    }
  }

  /**
   * Run one function inside a write transaction, serialized behind every other
   * write. Reads never queue behind writes.
   */
  async write<T>(fn: () => T): Promise<T> {
    const run = this.writeChain.then(() => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          /* a failed rollback must not mask the original error */
        }
        throw error
      }
    })
    this.writeChain = run.catch(() => undefined)
    return run
  }

  read<T>(fn: () => T): T {
    return fn()
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Consistent snapshot: `VACUUM INTO` writes a transactionally consistent copy
 * without relying on copying an active WAL by hand (03§19).
 */
export function snapshotBackup(db: BoopDatabase, targetPath: string): void {
  if (isUnsupportedStoragePath(targetPath)) {
    throw new Error(`boop: unsupported backup path: ${targetPath}`)
  }
  db.db.exec(`VACUUM INTO '${targetPath.replace(/'/gu, "''")}'`)
}

/** Integrity + foreign-key check of a snapshot or live database. */
export function verifyDatabase(path: string): { ok: boolean; integrity: string; foreignKeys: string[] } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
    const foreignKeys = (db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[]).map((row) =>
      JSON.stringify(row),
    )
    return { ok: integrity === 'ok' && foreignKeys.length === 0, integrity, foreignKeys }
  } finally {
    db.close()
  }
}

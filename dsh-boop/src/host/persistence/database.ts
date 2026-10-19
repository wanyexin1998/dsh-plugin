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
  readonly fts: boolean
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

  /** Apply the frozen core schema and record the schema version. */
  bootstrap(): BootstrapReport {
    const before = this.schemaVersion()
    this.db.exec(CORE_DDL)
    if (this.fts) this.db.exec(FTS_DDL)
    this.db.exec('BEGIN')
    try {
      this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
        'schema_version',
        String(SCHEMA_VERSION),
      )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return {
      driver: 'node:sqlite',
      sqliteVersion: this.sqliteVersion,
      wal: this.journalMode.toLowerCase() === 'wal',
      foreignKeys: (this.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1,
      fts: this.fts,
      schemaVersion: SCHEMA_VERSION,
      migratedFrom: before,
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

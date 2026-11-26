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
import { BASELINE_SCHEMA_VERSION, CORE_DDL, FTS_DDL, SCHEMA_VERSION } from './schema.ts'

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
  /** True when the ledger is newer than this build. Bootstrap did not touch it. */
  futureSchema: boolean
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
  /** Same connection as `db`, without the write fence. Lease renewal uses it. */
  readonly raw: DatabaseSync
  /** Row-changing statements pass through the process write fence once one is installed. */
  readonly db: DatabaseSync
  readonly path: string
  fts: boolean
  private readonly now: () => number
  /** Single write queue: every write transaction is chained onto this promise. */
  private writeChain: Promise<unknown> = Promise.resolve()
  /**
   * Set only after this process holds the writer lease. Null during bootstrap
   * and migration so those steps can record the baseline version.
   */
  private writeGuard: (() => void) | null = null

  constructor(options: BoopDatabaseOptions) {
    if (isUnsupportedStoragePath(options.path)) {
      throw new Error(`boop: unsupported storage path (network share or drive root): ${options.path}`)
    }
    this.path = options.path
    this.now = options.now ?? Date.now
    this.raw = new DatabaseSync(options.path)
    this.db = guardWrites(this.raw, () => this.writeGuard?.())
    const wal = options.wal ?? options.path !== ':memory:'
    if (wal) this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA synchronous = FULL')
    this.fts = options.fts ?? false
  }

  /** Install or clear the process-local write fence. Does not consult the row by itself. */
  setWriteGuard(guard: (() => void) | null): void {
    this.writeGuard = guard
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
   * Apply the baseline DDL. Record `schema_version` only when the ledger has
   * none. An existing version is left untouched so a later `migrate()` can
   * still see the real source version. A newer ledger is not modified.
   */
  bootstrap(): BootstrapReport {
    const before = this.schemaVersion()
    if (before !== null && before > SCHEMA_VERSION) {
      return {
        driver: 'node:sqlite',
        sqliteVersion: this.sqliteVersion,
        wal: this.journalMode.toLowerCase() === 'wal',
        foreignKeys: (this.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1,
        fts: this.fts,
        schemaVersion: before,
        migratedFrom: before,
        futureSchema: true,
      }
    }
    this.db.exec(CORE_DDL)
    if (before === null || before === BASELINE_SCHEMA_VERSION) this.ensureSubjectKey()
    if (this.fts) {
      try {
        this.db.exec(FTS_DDL)
      } catch {
        // FTS is derived. A build without FTS5 keeps the ledger and degrades
        // retrieval to exact match; it never weakens forget or authority rules.
        this.fts = false
      }
    }
    if (before === null) {
      this.db.exec('BEGIN')
      try {
        this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('schema_version', String(BASELINE_SCHEMA_VERSION))
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    return {
      driver: 'node:sqlite',
      sqliteVersion: this.sqliteVersion,
      wal: this.journalMode.toLowerCase() === 'wal',
      foreignKeys: (this.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1,
      fts: this.fts,
      schemaVersion: this.schemaVersion() ?? BASELINE_SCHEMA_VERSION,
      migratedFrom: before,
      futureSchema: false,
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

  /**
   * Synchronous transaction for startup migration. There is no other writer
   * yet, and the SQL must not wait on anything outside the ledger.
   */
  writeSync<T>(fn: () => T): T {
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
/** True when a statement can change rows. DDL and reads stay outside the fence. */
export function writesSql(sql: string): boolean {
  return /(^|;)\s*(insert|update|delete|replace)\b/iu.test(sql)
}

/**
 * Route row-changing `prepare().run` and `exec` through `guard`. Reads,
 * pragmas, and DDL call the raw database so bootstrap can still create tables.
 */
function guardWrites(raw: DatabaseSync, guard: () => void): DatabaseSync {
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql)
          if (!writesSql(sql)) return statement
          return new Proxy(statement, {
            get(stmt, stmtProp, stmtReceiver) {
              if (stmtProp === 'run') {
                return (...args: unknown[]) => {
                  guard()
                  return statement.run(...args)
                }
              }
              const value = Reflect.get(stmt, stmtProp, stmtReceiver)
              return typeof value === 'function' ? value.bind(statement) : value
            },
          })
        }
      }
      if (prop === 'exec') {
        return (sql: string) => {
          if (writesSql(sql)) guard()
          return target.exec(sql)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as DatabaseSync
}

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

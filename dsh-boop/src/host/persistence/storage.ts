/**
 * BOOP storage service (E01-01 + E01-02 wiring).
 *
 * Owns the one ledger file for this data domain and the single-writer lease.
 * Frozen rules (03§05):
 *  version check → DB → scope lease → RECOVERY GATE → tools/api/ui.
 *
 * The database lives under the host's own `$DSH_HOME` (`ctx.dshHomePath`),
 * never under the working directory, so two projects share exactly one BOOP
 * ledger. The scope id is derived from the normalized DSH_HOME plus the local
 * owner id, so the same installation always opens the same data domain.
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { BoopDatabase } from './database.ts'
import { migrate, type MigrationReport } from './migrate.ts'
import { LeaseManager, createSqliteLeaseStore } from './lease.ts'
import { BoopRepository } from './repository.ts'
import type { ScopeIdentity } from '../../shared/types.ts'

export interface StorageConfig {
  /** Sub-directory under `$DSH_HOME`; the ledger is `<dir>/boop.sqlite`. */
  directoryName?: string
  /** Lease holder identity; defaults to `pid@host` so a restart re-acquires. */
  holder?: string
  leaseTtlMs?: number
  /** Disables write management entirely (read-only inspection). */
  readOnly?: boolean
}

export interface StorageFacts {
  ok: boolean
  path: string
  schemaVersion: number | null
  sqliteVersion: string
  wal: boolean
  migration: MigrationReport | null
  lease: { held: boolean; holder: string; fencingToken: number; released: boolean }
  scope: ScopeIdentity
  /**
   * Ids this process already moved off `sending` or `running` while taking the
   * lease. A later reconcile call will not see those rows as `sending` again.
   */
  bootReconcile: { unknown: string[]; retryable: number } | null
  error?: string
}

const LOCAL_OWNER_ID = 'dsh-local-owner'

/**
 * Stable scope id for one installation (03§02): a hash of the normalized
 * DSH_HOME path plus the local owner identity. No machine name, no user name,
 * no project path — so the id is stable across restarts and identical for the
 * Web and Desktop surfaces of the same installation.
 */
export function deriveScopeIdentity(dshHome: string, ownerId: string = LOCAL_OWNER_ID): ScopeIdentity {
  const normalized = normalizeHome(dshHome)
  const fingerprint = createHash('sha256').update(normalized).digest('hex').slice(0, 32)
  return {
    scopeId: `boop-${fingerprint.slice(0, 16)}`,
    ownerId,
    dshHomeFingerprint: fingerprint,
  }
}

/** Windows case-insensitive paths must produce one identity, not two. */
function normalizeHome(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export class BoopStorage {
  readonly db: BoopDatabase
  readonly repo: BoopRepository
  readonly lease: LeaseManager
  readonly identity: ScopeIdentity
  migration: MigrationReport | null
  private released = false
  private ownsLease = false
  private fencingToken = 0
  private readonly holder: string
  private readonly leaseTtlMs: number
  /**
   * Keeps this Host's writer lease alive between business writes (G08 gap).
   * Without it a healthy Host's lease expires after the TTL and a second Host
   * may take over (AT-02 takeover is only for EXPIRED leases).
   */
  heartbeat: ReturnType<typeof setInterval> | null = null
  /** True only when the previous process set the marker on a graceful close. */
  previousShutdownClean = false
  bootReconcile: { unknown: string[]; retryable: number } | null = null

  constructor(options: { dshHome: string; directoryName?: string; holder?: string; leaseTtlMs?: number }) {
    this.identity = deriveScopeIdentity(options.dshHome)
    this.holder = options.holder ?? `dsh@${process.pid}`
    const dir = path.join(options.dshHome, options.directoryName ?? 'boop')
    // The ledger directory is BOOP's own state under $DSH_HOME; create it once.
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'boop.sqlite')
    this.db = new BoopDatabase({ path: file, fts: true })
    this.db.bootstrap()
    this.migration = null
    this.repo = new BoopRepository(this.db, undefined, () => `b_${Math.random().toString(36).slice(2, 12)}`)
    this.leaseTtlMs = options.leaseTtlMs ?? 15_000
    this.lease = new LeaseManager(createSqliteLeaseStore(this.db.raw), Date.now, this.leaseTtlMs)
  }

  /**
   * Renew the writer lease in-process until close(). A renewal can never
   * resurrect a lease another Host already took over (the store rejects a stale
   * holder), and the timer is unref'd so it never keeps a process alive.
   */
  private startHeartbeat(): void {
    if (this.heartbeat !== null) return
    const period = Math.max(100, Math.floor(this.leaseTtlMs / 3))
    this.heartbeat = setInterval(() => {
      try {
        if (this.released) return
        this.lease.acquire(this.identity.scopeId, this.holder)
      } catch {
        /* a heartbeat failure is visible through patrol; never crash the Host */
      }
    }, period)
    ;(this.heartbeat as unknown as { unref?: () => void }).unref?.()
  }

  /** Run migrations with a pre-migration consistent backup. */
  migrateNow(): MigrationReport {
    return migrate(this.db, {
      backupDir: path.join(path.dirname(this.db.path), 'backups'),
    })
  }

  /** Create the data domain and take the single-writer lease. */
  start(): StorageFacts {
    try {
      this.migration = this.migrateNow()
    } catch (error) {
      try {
        this.freezeReadOnly()
        this.close()
      } catch {
        /* keep the migration error; the ledger is already closed or read-only */
      }
      throw error
    }
    if (this.migration.refused || this.migration.integrity !== 'ok') {
      this.freezeReadOnly()
      return this.facts(false)
    }
    this.repo.ensureScope(this.identity.scopeId, this.identity.ownerId)
    const acquired = this.lease.acquire(this.identity.scopeId, this.holder)
    if (acquired.kind === 'held') {
      // Another live Host owns the write management for this domain. BOOP stays
      // read-only here instead of fighting over the ledger (03§02).
      this.freezeReadOnly()
    } else {
      this.ownsLease = true
      this.fencingToken = acquired.lease.fencingToken
      this.armWriteGuard()
      this.startHeartbeat()
      // Production boot reconciliation (G03): a crashed `sending` or `running`
      // row becomes outcome_unknown and is never auto-retried. The list is
      // kept on this process and returned by facts(); a later reconcile call
      // no longer sees those rows as `sending`. The clean-shutdown marker is
      // cleared now and written back only from close().
      this.previousShutdownClean = this.repo.getMeta('clean_shutdown') === '1'
      this.bootReconcile = this.repo.reconcileOutbox(this.identity.scopeId)
      this.repo.setMeta('clean_shutdown', '0')
      this.repo.audit(
        this.identity.scopeId,
        'boot/reconciled',
        null,
        'system',
        `clean=${this.previousShutdownClean} unknown=${this.bootReconcile.unknown.length}`,
      )
    }
    return this.facts(acquired.kind === 'acquired')
  }

  facts(held: boolean): StorageFacts {
    let leaseHolder = ''
    let token = 0
    try {
      const row = this.db.db
        .prepare('SELECT holder, fencing_token FROM runtime_lease WHERE scope_id = ?')
        .get(this.identity.scopeId) as { holder: string; fencing_token: number } | undefined
      leaseHolder = row?.holder ?? ''
      token = Number(row?.fencing_token ?? 0)
    } catch {
      /* the lease table may not exist yet on a cold migration */
    }
    return {
      ok: held,
      path: this.db.path,
      schemaVersion: this.db.schemaVersion(),
      sqliteVersion: this.db.sqliteVersion,
      wal: this.db.journalMode.toLowerCase() === 'wal',
      migration: this.migration,
      lease: { held, holder: leaseHolder, fencingToken: token, released: this.released },
      scope: this.identity,
      bootReconcile: this.bootReconcile,
    }
  }

  /**
   * Fence for this process. Uses the holder and token captured at acquire,
   * never the current row: a takeover must not let the old process present
   * the new owner's token as its own.
   */
  checkWrite(): { ok: true } | { ok: false; reason: string } {
    if (!this.ownsLease) return { ok: false, reason: 'this process does not hold the writer lease' }
    return this.lease.checkWrite(this.identity.scopeId, this.holder, this.fencingToken)
  }

  private armWriteGuard(): void {
    this.db.setWriteGuard(() => {
      const gate = this.checkWrite()
      if (!gate.ok) throw new Error(`boop: write refused: ${gate.reason}`)
    })
  }

  private freezeReadOnly(): void {
    this.db.setWriteGuard(() => {
      throw new Error('boop: write refused: this process does not hold the writer lease')
    })
    try {
      this.db.db.exec('PRAGMA query_only = ON')
    } catch {
      /* a closed database has already stopped writes */
    }
  }

  private leaseStoreRead(): { holder: string; fencingToken: number } | null {
    const row = this.db.db
      .prepare('SELECT holder, fencing_token FROM runtime_lease WHERE scope_id = ?')
      .get(this.identity.scopeId) as { holder: string; fencing_token: number } | undefined
    return row ? { holder: row.holder, fencingToken: Number(row.fencing_token) } : null
  }

  release(): void {
    // A read-only Host (lease held by another process) must NEVER release the
    // owner's lease: closing it would otherwise clear the live controller's row.
    if (!this.ownsLease) return
    const released = this.lease.release(this.identity.scopeId, this.holder, this.fencingToken)
    this.ownsLease = false
    this.released = released
  }

  close(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    if (this.ownsLease) {
      try {
        this.repo.setMeta('clean_shutdown', '1')
      } catch {
        /* a marker failure must not skip releasing the lease */
      }
    }
    this.release()
    this.db.close()
  }
}
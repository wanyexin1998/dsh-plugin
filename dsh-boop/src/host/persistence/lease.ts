/**
 * Scope lease: one effective writer per data domain (03§02, AT-02, RK-05).
 *
 * Rules enforced here:
 *  - a lease is held by exactly one holder and carries a monotonically
 *    increasing `fencingToken`;
 *  - an expired lease can be taken over, and the takeover MINTED token is
 *    strictly greater than the old one, so every write path that carries the
 *    old token is refused afterwards;
 *  - renewing with a stale token fails instead of silently extending a holder
 *    that has already been fenced out;
 *  - losing the lease stops new dispatch; it never resumes business by itself
 *    (03§09: "lease 丢失 → 停止新派发，旧者持有的 fencingToken 无效").
 */

export interface LeaseRecord {
  scopeId: string
  holder: string
  fencingToken: number
  expiresAtMs: number
}

export type LeaseAcquireResult =
  | { kind: 'acquired'; lease: LeaseRecord; /** Present when this acquisition fenced an earlier holder. */ fenced?: LeaseRecord }
  | { kind: 'held'; lease: LeaseRecord }

export interface LeaseStore {
  read(scopeId: string): LeaseRecord | null
  insert(record: LeaseRecord): void
  update(record: LeaseRecord): void
}

export class LeaseManager {
  private readonly store: LeaseStore
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(store: LeaseStore, now: () => number = Date.now, ttlMs = 15_000) {
    this.store = store
    this.now = now
    this.ttlMs = ttlMs
  }

  /**
   * Acquire or renew the write control for `scopeId`.
   *
   * - No lease, or an expired one → acquired (takeover mints token+1).
   * - A live lease owned by `holder` → renewed with the same token.
   * - A live lease owned by another holder → held (caller must stay read-only).
   */
  acquire(scopeId: string, holder: string): LeaseAcquireResult {
    const now = this.now()
    const current = this.store.read(scopeId)
    if (current && current.holder === holder && current.expiresAtMs > now) {
      const renewed: LeaseRecord = { ...current, expiresAtMs: now + this.ttlMs }
      this.store.update(renewed)
      return { kind: 'acquired', lease: renewed }
    }
    if (current && current.expiresAtMs > now) return { kind: 'held', lease: current }
    const next: LeaseRecord = {
      scopeId,
      holder,
      fencingToken: (current?.fencingToken ?? 0) + 1,
      expiresAtMs: now + this.ttlMs,
    }
    if (current) this.store.update(next)
    else this.store.insert(next)
    return current ? { kind: 'acquired', lease: next, fenced: current } : { kind: 'acquired', lease: next }
  }

  /**
   * Guard for every write path: the caller's token must be the live lease's
   * token, and the lease must not have expired. A fenced or expired holder is
   * refused — it does not silently resume business.
   */
  checkWrite(scopeId: string, holder: string, fencingToken: number): { ok: true } | { ok: false; reason: string } {
    const current = this.store.read(scopeId)
    if (!current) return { ok: false, reason: 'no lease for scope' }
    // The fencing token is checked first: a superseded holder must be named as
    // fenced even when a newer holder also owns the lease.
    if (current.fencingToken !== fencingToken) return { ok: false, reason: 'fencing token superseded' }
    if (current.holder !== holder) return { ok: false, reason: 'lease held by another controller' }
    if (current.expiresAtMs <= this.now()) return { ok: false, reason: 'lease expired; recovery required' }
    return { ok: true }
  }

  release(scopeId: string, holder: string, fencingToken: number): boolean {
    const current = this.store.read(scopeId)
    if (!current || current.holder !== holder || current.fencingToken !== fencingToken) return false
    this.store.update({ ...current, expiresAtMs: 0 })
    return true
  }
}

/** SQLite-backed lease store over `runtime_lease`. */
export class SqliteLeaseStore implements LeaseStore {
  private readonly db: { prepare: (sql: string) => any }

  constructor(db: { prepare: (sql: string) => any }) {
    this.db = db
  }

  read(scopeId: string): LeaseRecord | null {
    const row = this.db
      .prepare('SELECT scope_id, holder, fencing_token, expires_at FROM runtime_lease WHERE scope_id = ?')
      .get(scopeId) as { scope_id: string; holder: string; fencing_token: number; expires_at: string } | undefined
    if (!row) return null
    return {
      scopeId: row.scope_id,
      holder: row.holder,
      fencingToken: Number(row.fencing_token),
      expiresAtMs: Number(row.expires_at),
    }
  }

  insert(record: LeaseRecord): void {
    this.db
      .prepare('INSERT INTO runtime_lease(scope_id, holder, fencing_token, expires_at) VALUES(?,?,?,?)')
      .run(record.scopeId, record.holder, record.fencingToken, String(record.expiresAtMs))
  }

  update(record: LeaseRecord): void {
    this.db
      .prepare('UPDATE runtime_lease SET holder=?, fencing_token=?, expires_at=? WHERE scope_id=?')
      .run(record.holder, record.fencingToken, String(record.expiresAtMs), record.scopeId)
  }
}

export function createSqliteLeaseStore(db: { prepare: (sql: string) => any }): SqliteLeaseStore {
  return new SqliteLeaseStore(db)
}

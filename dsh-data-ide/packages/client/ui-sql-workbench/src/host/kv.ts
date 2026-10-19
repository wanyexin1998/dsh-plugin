/**
 * Key/value port over the host storage seam.
 *
 * 0.1.7 storage is domain-based: a plugin declares a `DomainSpec`
 * (`packages/storage/storage-domain/lib/types/spec.d.ts` L31-67) and opens it
 * through `ctx.storageDomain`, receiving a global unit plus named tables with
 * `get/put/update/delete/entries`. This port is that surface minus the host
 * types, so the store logic is testable without a running harness
 * (docs/06 §12.7.7 explains why host types are self-declared).
 */
export interface KvStore {
  /** Read one record, or `undefined` when absent or unreadable. */
  get(key: string): Promise<unknown>
  /** Create or replace one record. */
  put(key: string, value: unknown): Promise<void>
  /** Remove one record; resolves whether it existed. */
  delete(key: string): Promise<boolean>
  /** Every readable record, in insertion order. */
  entries(): Promise<readonly { key: string; value: unknown }[]>
}

/** In-memory store: the test double and the fallback when no host storage exists. */
export function createMemoryKvStore(seed: Record<string, unknown> = {}): KvStore {
  const records = new Map<string, unknown>(Object.entries(seed))
  return {
    get: async key => records.get(key),
    put: async (key, value) => {
      records.set(key, value)
    },
    delete: async key => records.delete(key),
    entries: async () => [...records].map(([key, value]) => ({ key, value })),
  }
}

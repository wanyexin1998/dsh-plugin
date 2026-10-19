/**
 * Credential handling for data source passwords.
 *
 * The host owns the credential store (`ctx.credentials`): keys are two-segment
 * `<scope>/<id>` with both halves matching `[a-z][a-z0-9-]*`
 * (`packages/credentials/credentials/src/index.ts` L18-19), and `modifyRecord`
 * is the only write path (L247-257). Session-scoped secrets never reach it —
 * they live in memory for the lifetime of this process, mirroring DataGrip's
 * `LocalDataSource$Storage{SESSION}` (docs/01 R1, docs/04 §4).
 */

/** Where a password is allowed to live. */
export type { SecretStorage } from '../datasource/model.ts'

import type { SecretStorage } from '../datasource/model.ts'

export interface SecretPayload {
  readonly password: string
  readonly secretStorage: SecretStorage
}

/** One record as the host lists it (`ctx.credentials.listRecords`). */
export interface CredentialRecordEntry {
  readonly key: string
}

/** The slice of `ctx.credentials` this store needs. */
export interface CredentialsPort {
  readRecord(key: string): Promise<unknown | undefined>
  modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown | undefined>): Promise<unknown | undefined>
  deleteRecord(key: string): Promise<void>
  listRecords(): Promise<readonly CredentialRecordEntry[]>
}

import { credentialId } from '../datasource/model.ts'

/** Credential scope; the second key half is the normalised per-connection id. */
export const CREDENTIAL_SCOPE = 'dsh-data-ide'

/**
 * Build the two-segment credential key for a connection.
 *
 * The second half is the normalised id (`ds-<8hex>`), because key halves must
 * match `[a-z][a-z0-9-]*` and a UUID does not (docs/04 §4).
 */
export function credentialKey(connId: string): string {
  return `${CREDENTIAL_SCOPE}/${credentialId(connId)}`
}

/**
 * Read the payload shape defensively: anything unexpected reads as absent.
 *
 * Two shapes are accepted. The host only stores tagged records — `{kind:'grant',
 * payload}` — and rejects anything else when it loads the file at boot; writing a
 * flat `{password, secretStorage}` record made the whole credentials plugin fail
 * to activate (2026-10-19). The flat shape is still read so files written before
 * that fix keep working until the next save.
 */
function parsePayload(raw: unknown): SecretPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const nested = record['payload']
  const body = (typeof nested === 'object' && nested !== null ? nested : record) as Record<string, unknown>
  const password = body['password']
  const storage = body['secretStorage']
  if (typeof password !== 'string') return undefined
  if (storage !== 'master_key' && storage !== 'session') return undefined
  return { password, secretStorage: storage }
}

/**
 * The record shape the host accepts: a tagged grant whose payload is free-form.
 *
 * `parseRecord` in `@deepseek-ai/dsh-credentials-local` allows exactly
 * `kind: 'api-key' | 'grant'` plus the fields of that tag; an unknown field or a
 * missing `kind` aborts the whole credential file at startup.
 */
function toHostRecord(payload: SecretPayload): { readonly kind: 'grant'; readonly payload: SecretPayload & { readonly version: 1 } } {
  return { kind: 'grant', payload: { version: 1, ...payload } }
}

export interface CredentialStore {
  /** Store a password; `session` keeps it in memory only. */
  set(connId: string, password: string, storage: SecretStorage): Promise<void>
  /** Resolve a password, preferring the in-memory session secret. */
  resolve(connId: string): Promise<string | undefined>
  /** Drop both the persisted record and any session secret. */
  remove(connId: string): Promise<void>
  /** Drop by the already-normalised id, as returned by `storedIds()`. */
  removeNormalized(normalizedId: string): Promise<void>
  /** Connections that still hold a credential record under our scope. */
  storedIds(): Promise<readonly string[]>
  /** How many session-only secrets are held in memory. */
  sessionCount(): number
}

/** Build the store over the host credential seam. */
export function createCredentialStore(credentials: CredentialsPort): CredentialStore {
  const session = new Map<string, string>()

  return {
    async set(connId, password, storage) {
      const normalized = credentialId(connId)
      if (storage === 'session') {
        session.set(normalized, password)
        // A persisted copy must not outlive a switch to session-only storage.
        await credentials.deleteRecord(credentialKey(connId))
        return
      }
      session.delete(normalized)
      await credentials.modifyRecord(credentialKey(connId), async () => toHostRecord({ password, secretStorage: storage }))
    },

    async resolve(connId) {
      const inMemory = session.get(credentialId(connId))
      if (inMemory !== undefined) return inMemory
      const raw = await credentials.readRecord(credentialKey(connId))
      const stored = parsePayload(raw)
      if (stored === undefined && raw !== undefined) {
        // Shape diagnostics only — never the secret itself.
        const record = raw as Record<string, unknown>
        const payload = record['payload']
        console.error('[dsh-data-ide] credential record shape', {
          keys: Object.keys(record),
          kind: record['kind'],
          payloadKeys: typeof payload === 'object' && payload !== null ? Object.keys(payload) : typeof payload,
        })
      }
      return stored?.password
    },

    async remove(connId) {
      session.delete(credentialId(connId))
      await credentials.deleteRecord(credentialKey(connId))
    },

    async removeNormalized(normalizedId) {
      session.delete(normalizedId)
      await credentials.deleteRecord(`${CREDENTIAL_SCOPE}/${normalizedId}`)
    },

    async storedIds() {
      const records = await credentials.listRecords()
      return records
        .map(entry => entry.key)
        .filter(key => key.startsWith(`${CREDENTIAL_SCOPE}/`))
        .map(key => key.slice(CREDENTIAL_SCOPE.length + 1))
    },

    sessionCount() {
      return session.size
    },
  }
}

/**
 * Drop credentials whose connection no longer exists (docs/04 §8).
 *
 * Deleting a data source must not leave its password behind, so the host calls
 * this with the surviving ids after a removal.
 *
 * Surviving ids are normalised the same way the keys are, so callers can pass
 * the raw connection ids they already hold.
 *
 * @param store - Credential store to clean.
 * @param survivingIds - Connection ids that still exist.
 * @returns The ids whose secrets were dropped.
 */
export async function pruneOrphanCredentials(
  store: CredentialStore,
  survivingIds: readonly string[],
): Promise<readonly string[]> {
  const surviving = new Set(survivingIds.map(credentialId))
  const dropped: string[] = []
  for (const id of await store.storedIds()) {
    if (surviving.has(id)) continue
    await store.removeNormalized(id)
    dropped.push(id)
  }
  return dropped
}

/**
 * Data source model — the persisted shape (docs/04 §2) plus per-DBMS defaults.
 *
 * A `DataSource` never carries a password: secrets live in the host credential
 * store under `dsh-data-ide/<credentialId>` (04 §4).
 */

/** Supported engines. Oracle is deferred to P1 (docs/08 R4). */
export type Dbms = 'doris' | 'mysql'

export interface CaseSensitivity {
  readonly plain: 'upper' | 'lower' | 'exact'
  readonly quoted: 'exact'
}

/** Connection-test product facts, mirrored from DataGrip's `database-info`. */
export interface DatabaseInfo {
  readonly product: string
  readonly version: string
  readonly jdbcVersion?: string
  readonly driverVersion: string
  readonly dbms: string
  readonly exactVersion?: string
  readonly identifierQuoteString: string
  readonly extraNameCharacters?: string
  readonly caseSensitivity: CaseSensitivity
}

export type TestState = 'YES' | 'NO' | 'UNSURE'

/** Where a password is allowed to live (docs/04 §4). */
export type SecretStorage = 'master_key' | 'session'

/**
 * Editable projection the panel posts to the host: a stored `DataSource` minus
 * the fields the host owns, plus the optional password.
 *
 * Shared by the browser half (form state) and the node half (save route), so it
 * lives with the model rather than in either half.
 */
export interface ConnectionDraft {
  readonly id?: string
  readonly name: string
  readonly dbms: Dbms
  readonly host: string
  readonly port: number
  readonly database?: string
  readonly username: string
  readonly driverProperties?: Record<string, string>
  readonly writeEnabled?: boolean
  readonly comment?: string
  readonly password?: string
  readonly secretStorage?: SecretStorage
}

export interface DataSource {
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly dbms: Dbms
  readonly host: string
  readonly port: number
  readonly database?: string
  readonly username: string
  readonly driverProperties: Readonly<Record<string, string>>
  /** Agent write access stays off until a human turns it on (docs/05 §6). */
  readonly writeEnabled: boolean
  readonly comment?: string
  readonly databaseInfo?: DatabaseInfo
  readonly lastTestedAt?: string
  readonly lastTestState?: TestState
}

/** Engine defaults; Doris speaks the MySQL wire protocol on 9030 (RUNTIME-FINDINGS §2.2). */
export const DBMS_DEFAULTS: Readonly<Record<Dbms, { readonly port: number; readonly driverProperties: Readonly<Record<string, string>> }>> = {
  doris: { port: 9030, driverProperties: { rewriteBatchedStatements: 'TRUE' } },
  mysql: { port: 3306, driverProperties: {} },
}

/** Build a data source with engine defaults applied and no secret. */
export function createDataSource(input: {
  readonly id: string
  readonly name: string
  readonly dbms: Dbms
  readonly host: string
  readonly port?: number
  readonly database?: string
  readonly username: string
  readonly driverProperties?: Record<string, string>
  readonly writeEnabled?: boolean
  readonly comment?: string
}): DataSource {
  const defaults = DBMS_DEFAULTS[input.dbms]
  return {
    schemaVersion: 1,
    id: input.id,
    name: input.name,
    dbms: input.dbms,
    host: input.host,
    port: input.port ?? defaults.port,
    ...(input.database === undefined ? {} : { database: input.database }),
    username: input.username,
    driverProperties: { ...defaults.driverProperties, ...input.driverProperties },
    writeEnabled: input.writeEnabled ?? false,
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  }
}

/** Validation result; the UI turns these into field-level messages (03 §4.2). */
export type ValidationResult = { readonly ok: true } | { readonly ok: false; readonly field: string; readonly reason: string }

/** Reject a draft before it reaches storage or the wire. */
export function validateDataSource(draft: {
  readonly name: string
  readonly dbms: Dbms
  readonly host: string
  readonly port: number
  readonly username: string
}): ValidationResult {
  if (draft.name.trim() === '') return { ok: false, field: 'name', reason: '名称不能为空' }
  if (draft.host.trim() === '') return { ok: false, field: 'host', reason: '主机不能为空' }
  if (draft.username.trim() === '') return { ok: false, field: 'username', reason: '用户名不能为空' }
  if (!Number.isInteger(draft.port) || draft.port <= 0 || draft.port > 65535) {
    return { ok: false, field: 'port', reason: '端口需为 1-65535 的整数' }
  }
  return { ok: true }
}

/**
 * Credential-safe id derived from a UUID connection id.
 *
 * dsh credential keys accept `[a-z][a-z0-9-]*` per half
 * (`packages/credentials/credentials/src/index.ts` L18-19), and record keys must
 * match `[a-zA-Z0-9_-]+` for the storage backend — so a UUID becomes `ds-<8hex>`.
 */
export function credentialId(connId: string): string {
  const hex = connId.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  return `ds-${(hex + '0'.repeat(8)).slice(0, 8)}`
}

/**
 * The slice of the dsh **node-half** host surface this plugin consumes.
 *
 * Declared locally for the same reason as the client half (docs/06 §12.7.7):
 * the 0.1.7 packages are not published to npm, so importing their types would
 * make this repository unbuildable on its own. Field shapes mirror
 * `packages/storage/storage-domain` and `packages/credentials/credentials`.
 */

/** Disposer returned by registrations. */
export type Disposer = () => void | Promise<void>

/** Zod-like schema placeholder; the host validates values with the real one. */
export type ValueSchema = unknown

/** One table inside a domain unit. */
export interface KvTable {
  get(key: string): unknown
  entries(): IterableIterator<[string, unknown]>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
}

/** An opened domain unit. */
export interface Domain {
  table(name: string): KvTable
  close(): Promise<void>
}

export interface DomainSpec {
  readonly name: string
  readonly version: number
  readonly layout?: 'single' | 'per-record'
  readonly compatibleVersions?: readonly number[]
  readonly tables: Readonly<Record<string, { readonly keySchema?: ValueSchema; readonly valueSchema: ValueSchema }>>
}

/** `ctx.storageDomain` — opens declared domains over routed backends. */
export interface DomainFacility {
  open(spec: DomainSpec): Promise<Domain>
}

/** `ctx.credentials` — the only sanctioned secret store. */
export interface CredentialsService {
  readRecord(key: string): Promise<unknown>
  modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>): Promise<unknown>
  deleteRecord(key: string): Promise<void>
  listRecords(): Promise<readonly { readonly key: string }[]>
}

/** The slice of `ctx.webServer` this plugin registers routes on. */
export interface WebServerService {
  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (req: unknown, res: unknown) => Promise<void> | void
  }): Disposer
}

/** The slice of `ctx.connection` used as a trust fence. */
export interface ConnectionService {
  requestRejection(req: unknown): number | undefined
}

/** Root node-half context. */
export interface NodeHostContext {
  effect<T>(setup: () => T | Promise<T>, label?: string): T | Promise<T>
  readonly storageDomain: DomainFacility
  readonly credentials: CredentialsService
  /** Harness-home path resolver, provided by app-boot (`ctx.dshHomePath`). */
  readonly dshHomePath?: (...segments: string[]) => string
  /** Service registration, used to publish the host-side API to the client half. */
  readonly reflect: { provide(key: string, value: unknown): Disposer }
  /**
   * Opportunistic service lookup.
   *
   * `webServer` carries the panel's routes and `connection` is the trust fence;
   * both are read through `get` rather than injected so the plugin still
   * activates in a composition without them (dsh-chat's precedent).
   */
  get?(name: string): unknown
  readonly webServer?: WebServerService
}

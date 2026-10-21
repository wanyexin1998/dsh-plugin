/**
 * The slice of the DSH client host surface this plugin consumes.
 *
 * The 0.1.7 host type packages are not published to npm (`dsh-client-ui-sidebar-right`
 * stops at 0.1.5-alpha.1), and the runtime the desktop app actually loads is a
 * locally linked rebuild. Declaring the consumed surface here keeps this
 * repository self-contained and keeps the shipped bundles free of any
 * `@deepseek-ai/*` import — services arrive through the Cordis context instead.
 *
 * Field shapes mirror the host contracts:
 *   - slots / locale: `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-locale`
 *   - sidebarRight / sidebarRightTabs: `packages/client/ui-sidebar-right/src/client/{index.ts,tab-registry.ts}`
 */

/** Disposer returned by every registration path. */
export type Disposer = () => void

/** Locale dictionaries keyed by message id. */
export type LocaleDictionary = Readonly<Record<string, string>>

export interface LocaleService {
  /** Register a namespace's dictionaries; returns a disposer. */
  register(namespace: string, dictionaries: { readonly zh: LocaleDictionary; readonly en: LocaleDictionary }): Disposer
  /** Bind a translator for a namespace; the result follows the active language. */
  bind(namespace: string): (id: string) => string
}

/** A slot entry: a static face plus the component the frame instantiates. */
export interface SlotRegistration {
  /** Slot name — must equal the injected slot. */
  readonly name: string
  /** Keyed seats address entries by `key`; list seats by `id`. */
  readonly key?: string
  readonly id?: string
  readonly order?: number
  readonly locale?: string
  /** Label thunk, so registration-time text follows the active language. */
  readonly label?: () => string
  /**
   * Props factory for the entry's component.
   *
   * The host **calls** it per render (`runInject`); handing it a plain record
   * throws `TypeError: inject is not a function` inside the seat, which crashes
   * the entry and leaves the pane blank (0.2.1, 2026-10-19).
   */
  readonly inject?: (...args: never[]) => Record<string, unknown>
}

export interface SlotsService {
  /** Mount an entry into a host-declared slot. */
  inject(slot: string, register: () => Disposer): Disposer
  /** Register one entry (component last, like the host's own packages). */
  register(registration: SlotRegistration, component?: unknown): Disposer
}

/** Page types are opened by kind; `multiple: false` keeps one page per session. */
export interface SidebarRightTabGuideEntry {
  readonly id: string
  readonly order: number
  readonly title: () => string
  readonly description?: () => string
  readonly icon?: unknown
}

export interface SidebarRightTabDefinition {
  /** Implementation identity — also the key the body and title seats register under. */
  readonly id: string
  /** Type discriminator `openTab` names. */
  readonly kind: string
  readonly multiple?: boolean
  readonly keepMounted?: boolean
  readonly patterns?: readonly string[]
  readonly priority?: 'extension' | 'builtin' | 'fallback'
  readonly canOpen?: (address: string) => boolean
  readonly title: (address: string) => string
  readonly guide?: readonly SidebarRightTabGuideEntry[]
}

export interface SidebarRightTabRegistry {
  /** Register a page type; returns a disposer. Duplicate ids throw. */
  register(definition: SidebarRightTabDefinition): Disposer
}

export interface SidebarRightPlacement {
  readonly preferNewPane?: boolean
  readonly paneId?: string
}

export interface SidebarRightController {
  /** Open a page type by kind. */
  openTab(kind: string, options?: SidebarRightPlacement): void
  /** Open a resource address in its owning tab type. */
  openResource(address: string, options?: SidebarRightPlacement): void
}

/** Root client context of the browser half. */
export interface ClientContext {
  /** Run a registration for the plugin's lifetime; returns whatever the callback returns. */
  effect<T>(setup: () => T, label?: string): T
  readonly slots: SlotsService
  readonly locale: LocaleService
  /** Right-sidebar face (presentation + navigation). */
  readonly sidebarRight?: SidebarRightController
  /** Right-sidebar page-type registry. */
  readonly sidebarRightTabs?: SidebarRightTabRegistry
}

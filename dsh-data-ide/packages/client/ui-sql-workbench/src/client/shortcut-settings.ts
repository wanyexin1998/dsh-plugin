/**
 * Editable keyboard shortcuts (user requirement 1).
 *
 * Every action the workbench advertises is one combo string (`Ctrl+Shift+E`).
 * This module is the pure half: parse / format / normalize combos, defaults,
 * conflict detection, and the persisted settings document. The settings panel
 * (`components/ShortcutSettings.tsx`) renders it, the panel wires persistence,
 * and `editor-cm.ts` turns the combos into a CodeMirror keymap that can be
 * reconfigured without remounting the editor.
 *
 * Storage is deliberately forgiving: shortcuts are a convenience, so a missing
 * `localStorage`, a denied access or a hand-edited JSON blob must degrade to the
 * defaults rather than break the panel.
 */

/** Every configurable action, in display order within its group. */
export const SHORTCUT_ACTIONS = [
  'run',
  'runAll',
  'rerun',
  'explain',
  'history',
  'format',
  'expandStar',
  'complete',
  'acceptCompletion',
  'cancel',
  'palette',
  'objectSearch',
] as const

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]

/** One combo string per action; always canonical (see {@link normalizeCombo}). */
export type ShortcutSettings = Readonly<Record<ShortcutAction, string>>

/** Which list the settings panel shows: editor-scoped or workbench-wide. */
export type ShortcutGroup = 'editor' | 'global'

/** Human copy for one row of the settings panel. */
export interface ShortcutMeta {
  readonly action: ShortcutAction
  readonly label: string
  readonly group: ShortcutGroup
}

/** Labels and grouping, in the order the settings panel renders them. */
export const SHORTCUT_META: readonly ShortcutMeta[] = [
  { action: 'run', label: '执行光标所在语句', group: 'editor' },
  { action: 'runAll', label: '执行整个脚本', group: 'editor' },
  { action: 'rerun', label: '重跑上次查询', group: 'editor' },
  { action: 'explain', label: '查看执行计划', group: 'editor' },
  { action: 'history', label: '打开查询历史', group: 'editor' },
  { action: 'format', label: '格式化 SQL', group: 'editor' },
  { action: 'expandStar', label: '展开星号', group: 'editor' },
  { action: 'complete', label: '唤起代码补全', group: 'editor' },
  { action: 'acceptCompletion', label: '接受补全（回车）', group: 'editor' },
  { action: 'cancel', label: '取消正在执行的语句', group: 'editor' },
  { action: 'palette', label: '命令面板', group: 'global' },
  { action: 'objectSearch', label: '全局对象搜索', group: 'global' },
]

/** Groups as the panel renders them; kept here so the component stays dumb. */
export interface ShortcutGroupMeta {
  readonly id: ShortcutGroup
  readonly title: string
  readonly actions: readonly ShortcutMeta[]
}

export const SHORTCUT_GROUPS: readonly ShortcutGroupMeta[] = [
  { id: 'editor', title: '编辑器', actions: SHORTCUT_META.filter(meta => meta.group === 'editor') },
  { id: 'global', title: '全局', actions: SHORTCUT_META.filter(meta => meta.group === 'global') },
]

/** Editor-scoped actions that `editor-cm.ts` binds into the CodeMirror keymap. */
export const KEYBOUND_SHORTCUT_ACTIONS = [
  'run',
  'runAll',
  'rerun',
  'explain',
  'format',
  'expandStar',
  'history',
  'complete',
  'acceptCompletion',
] as const satisfies readonly ShortcutAction[]

/**
 * Defaults kept identical to the bindings the editor shipped before settings
 * existed, so upgrading changes nothing for anyone who never opens the panel.
 * `Ctrl` chords are mirrored to `Cmd` when the keymap is built (see `keySpecs`).
 */
export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  run: 'Ctrl+Enter',
  runAll: 'Ctrl+Shift+Enter',
  rerun: 'Ctrl+Alt+Enter',
  explain: 'Ctrl+Shift+E',
  history: 'Ctrl+Shift+H',
  format: 'Ctrl+Alt+L',
  expandStar: 'Ctrl+Alt+S',
  complete: 'Ctrl+Space',
  acceptCompletion: 'Enter',
  cancel: 'Escape',
  palette: 'Ctrl+Shift+P',
  objectSearch: 'Ctrl+Shift+O',
}

/** A combo split into modifiers plus the canonical key name. */
export interface ParsedCombo {
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
  /** Canonical key name: `E`, `1`, `Enter`, `ArrowUp`, `F5`, `Escape`, … */
  readonly key: string
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
}

/**
 * Canonical spelling for one key name.
 *
 * Letters are upper-cased (`E`), function keys `F5`, named keys camel-cased.
 * Unknown multi-letter names return `null`: accepting them would silently create
 * a binding no browser event can ever match.
 */
function canonicalKey(raw: string): string | null {
  if (raw === '') return null
  const lower = raw.toLowerCase()
  const alias = KEY_ALIASES[lower]
  if (alias !== undefined) return alias
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return `F${lower.slice(1)}`
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase()
  // The space bar arrives as the single space character.
  if (raw === ' ') return 'Space'
  if (raw.length === 1) return raw
  return null
}

/**
 * Split a combo string into modifiers plus key.
 *
 * Accepts the aliases people actually type (`Cmd`/`Command`/`Meta`/`Super`,
 * `Option`, `Control`) and any modifier order, because the recorder can emit the
 * order the browser reports.
 *
 * @param combo - e.g. `Ctrl+Shift+E`.
 * @returns The parsed combo, or `null` when the string is not a combo.
 */
export function parseCombo(combo: string): ParsedCombo | null {
  const tokens = combo.split('+').map(token => token.trim())
  if (tokens.some(token => token === '')) return null
  let ctrl = false
  let alt = false
  let shift = false
  let meta = false
  let key: string | null = null
  for (const token of tokens) {
    switch (token.toLowerCase()) {
      case 'ctrl':
      case 'control':
        ctrl = true
        break
      case 'alt':
      case 'option':
        alt = true
        break
      case 'shift':
        shift = true
        break
      case 'cmd':
      case 'command':
      case 'meta':
      case 'super':
        meta = true
        break
      default: {
        if (key !== null) return null
        key = canonicalKey(token)
        if (key === null) return null
      }
    }
  }
  if (key === null) return null
  // Ctrl and Meta can both be true only for a hand-written combo. Keep Ctrl: the
  // keymap mirrors Ctrl to Cmd anyway, so both platforms still match.
  return { ctrl, alt, shift, meta: meta && !ctrl, key }
}

/**
 * Render a parsed combo in canonical order: `Ctrl+Alt+Shift+Meta+Key`.
 *
 * @param parsed - A combo from {@link parseCombo}.
 */
export function formatCombo(parsed: ParsedCombo): string {
  const parts: string[] = []
  if (parsed.ctrl) parts.push('Ctrl')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  if (parsed.meta) parts.push('Meta')
  parts.push(parsed.key)
  return parts.join('+')
}

/**
 * Canonicalize a combo string (case and modifier order), or reject it.
 *
 * @param combo - User/store supplied combo.
 * @returns `Ctrl+Shift+E`-style string, or `null` when unparseable.
 */
export function normalizeCombo(combo: string): string | null {
  const parsed = parseCombo(combo)
  return parsed === null ? null : formatCombo(parsed)
}

/**
 * The text the UI shows for a stored combo.
 *
 * Settings loaded through {@link loadSettings} are already canonical; this is
 * for values the panel received from elsewhere, so an unparseable string is
 * shown as-is instead of disappearing.
 */
export function displayCombo(combo: string): string {
  return normalizeCombo(combo) ?? combo
}

/** The subset of a DOM keyboard event the recorder reads. */
export interface ComboEvent {
  readonly key: string
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
  readonly shiftKey?: boolean
}

/** True for characters whose shifted form is itself (so Shift is redundant). */
function isShiftEncoded(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/i.test(key)
}

/**
 * Turn a recorded keydown into a combo string.
 *
 * Modifier-only presses return `null` (the recorder should keep waiting), and a
 * bare printable key returns `null` too: binding it would shadow ordinary typing
 * in the editor. Bare named keys such as `Escape` are allowed, which is how the
 * default cancel chord works.
 *
 * @param event - A keydown event (or the fields this module needs).
 * @returns A canonical combo, or `null` when the press cannot be a shortcut.
 */
export function comboFromEvent(event: ComboEvent): string | null {
  const key = canonicalKey(event.key)
  if (key === null) return null
  const ctrl = event.ctrlKey === true
  const meta = event.metaKey === true
  const alt = event.altKey === true
  let shift = event.shiftKey === true
  if (shift && isShiftEncoded(key)) shift = false
  const hasModifier = ctrl || alt || shift || meta
  if (!hasModifier && key.length === 1) return null
  return formatCombo({ ctrl, alt, shift, meta: meta && !ctrl, key })
}

/**
 * Actions whose combo is also used by another action.
 *
 * Only the actions involved are returned, so the panel can mark exactly the
 * rows that need attention. Unparseable combos cannot collide with anything.
 *
 * @param settings - Current shortcut map.
 */
export function conflictOf(settings: ShortcutSettings): readonly ShortcutAction[] {
  const seen = new Map<string, ShortcutAction>()
  const conflicts = new Set<ShortcutAction>()
  for (const action of SHORTCUT_ACTIONS) {
    const normalized = normalizeCombo(settings[action])
    if (normalized === null) continue
    const previous = seen.get(normalized)
    if (previous === undefined) {
      seen.set(normalized, action)
      continue
    }
    conflicts.add(previous)
    conflicts.add(action)
  }
  return [...conflicts]
}

/**
 * Merge a stored/unknown object with the defaults.
 *
 * Missing, wrongly-typed or unparseable actions fall back individually, so a
 * partial or edited document loses only what it cannot express.
 *
 * @param raw - Whatever `JSON.parse` produced.
 */
export function normalizeSettings(raw: unknown): ShortcutSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_SHORTCUTS
  const record = raw as Record<string, unknown>
  const settings: Record<ShortcutAction, string> = { ...DEFAULT_SHORTCUTS }
  for (const action of SHORTCUT_ACTIONS) {
    const value = record[action]
    if (typeof value !== 'string') continue
    const normalized = normalizeCombo(value)
    if (normalized !== null) settings[action] = normalized
  }
  return settings
}

/**
 * Copy a settings map with one action replaced, normalizing the new combo.
 *
 * @returns The unchanged input when the combo is unparseable.
 */
export function withShortcut(settings: ShortcutSettings, action: ShortcutAction, combo: string): ShortcutSettings {
  const normalized = normalizeCombo(combo)
  if (normalized === null) return settings
  return { ...settings, [action]: normalized }
}

/** localStorage key of the settings document. */
export const SHORTCUTS_STORAGE_KEY = 'dsh-data-ide.shortcuts'

/** The slice of `Storage` this module uses; injectable for tests. */
export interface ShortcutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Resolve `localStorage` without throwing in a non-browser or sandboxed context. */
function browserStorage(): ShortcutStorage | null {
  try {
    return (globalThis as { localStorage?: ShortcutStorage }).localStorage ?? null
  } catch {
    // Accessing the property can throw under a sandboxed frame / denied origin.
    return null
  }
}

/**
 * Read persisted shortcuts, falling back to the defaults.
 *
 * @param storage - Override for tests; defaults to `localStorage` when present.
 */
export function loadSettings(storage: ShortcutStorage | null = browserStorage()): ShortcutSettings {
  if (storage === null) return DEFAULT_SHORTCUTS
  try {
    const raw = storage.getItem(SHORTCUTS_STORAGE_KEY)
    if (raw === null) return DEFAULT_SHORTCUTS
    return normalizeSettings(JSON.parse(raw))
  } catch {
    // Denied storage or a corrupt document: defaults beat a broken panel.
    return DEFAULT_SHORTCUTS
  }
}

/**
 * Persist shortcuts, reporting whether the write happened.
 *
 * @param settings - Current map; normalized and merged with defaults first.
 * @param storage - Override for tests; defaults to `localStorage` when present.
 * @returns `false` in a non-browser context or when the write was refused.
 */
export function saveSettings(settings: ShortcutSettings, storage: ShortcutStorage | null = browserStorage()): boolean {
  if (storage === null) return false
  try {
    storage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(normalizeSettings(settings)))
    return true
  } catch {
    return false
  }
}

/** Key name as CodeMirror spells it in a binding spec (letters lower-case). */
function bindingKey(key: string): string {
  return /^[A-Z]$/.test(key) ? key.toLowerCase() : key
}

/**
 * CodeMirror key-spec strings for one combo.
 *
 * A `Ctrl` chord is mirrored to `Cmd` (and a recorded `Meta` chord to `Ctrl`) so
 * one setting works on both platforms, matching the pre-settings bindings that
 * listed `Mod-`, `Ctrl-` and `Cmd-` by hand.
 *
 * @param combo - Combo string; unparseable input yields no bindings.
 */
export function keySpecs(combo: string): readonly string[] {
  const parsed = parseCombo(combo)
  if (parsed === null) return []
  const spec = (ctrl: boolean, meta: boolean): string => {
    const parts: string[] = []
    if (ctrl) parts.push('Ctrl')
    if (meta) parts.push('Cmd')
    if (parsed.alt) parts.push('Alt')
    if (parsed.shift) parts.push('Shift')
    parts.push(bindingKey(parsed.key))
    return parts.join('-')
  }
  const specs = [spec(parsed.ctrl, parsed.meta)]
  if (parsed.ctrl) specs.push(spec(false, true))
  if (parsed.meta) specs.push(spec(true, false))
  return specs
}

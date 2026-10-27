import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ShortcutStorage } from '../src/client/shortcut-settings.ts'
import {
  DEFAULT_SHORTCUTS,
  KEYBOUND_SHORTCUT_ACTIONS,
  SHORTCUT_ACTIONS,
  SHORTCUT_GROUPS,
  SHORTCUT_META,
  SHORTCUTS_STORAGE_KEY,
  comboFromEvent,
  conflictOf,
  displayCombo,
  formatCombo,
  keySpecs,
  loadSettings,
  normalizeCombo,
  normalizeSettings,
  parseCombo,
  saveSettings,
  withShortcut,
} from '../src/client/shortcut-settings.ts'

/** In-memory Storage double with optional failure injection. */
function storageDouble(seed: Record<string, string> = {}, failures: { get?: Error; set?: Error } = {}) {
  const records = new Map(Object.entries(seed))
  const writes: { key: string; value: string }[] = []
  const storage: ShortcutStorage = {
    getItem(key) {
      if (failures.get !== undefined) throw failures.get
      return records.get(key) ?? null
    },
    setItem(key, value) {
      if (failures.set !== undefined) throw failures.set
      records.set(key, value)
      writes.push({ key, value })
    },
  }
  return { storage, records, writes }
}

describe('defaults and metadata', () => {
  it('keeps the shortcuts the editor shipped before settings existed', () => {
    expect(DEFAULT_SHORTCUTS).toMatchObject({
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
    })
  })

  it('describes every action exactly once and groups them by scope', () => {
    expect(SHORTCUT_META.map(meta => meta.action)).toEqual([...SHORTCUT_ACTIONS])
    expect(SHORTCUT_GROUPS.map(group => group.id)).toEqual(['editor', 'global'])
    expect(SHORTCUT_GROUPS[0]?.actions).toHaveLength(10)
    expect(SHORTCUT_GROUPS[0]?.actions.filter(meta => meta.action === 'complete')[0]?.label).toBe('唤起代码补全')
    expect(SHORTCUT_GROUPS[0]?.actions.filter(meta => meta.action === 'acceptCompletion')[0]?.label).toBe('接受补全（回车）')
    expect(SHORTCUT_GROUPS[1]?.actions.map(meta => meta.action)).toEqual(['palette', 'objectSearch'])
    expect(KEYBOUND_SHORTCUT_ACTIONS).toHaveLength(9)
    expect(KEYBOUND_SHORTCUT_ACTIONS).toEqual(expect.arrayContaining(['complete', 'acceptCompletion']))
  })
})

describe('parse / format / normalize', () => {
  it('parses a modifier chord in any order and spelling', () => {
    expect(parseCombo('Ctrl+Shift+E')).toEqual({ ctrl: true, alt: false, shift: true, meta: false, key: 'E' })
    expect(parseCombo('shift + ctrl + e')).toEqual({ ctrl: true, alt: false, shift: true, meta: false, key: 'E' })
    expect(parseCombo('Control+Option+Enter')).toEqual({ ctrl: true, alt: true, shift: false, meta: false, key: 'Enter' })
  })

  it('accepts every Cmd/Meta alias', () => {
    for (const modifier of ['Cmd', 'Command', 'Meta', 'Super']) {
      expect(parseCombo(`${modifier}+K`)).toEqual({ ctrl: false, alt: false, shift: false, meta: true, key: 'K' })
    }
  })

  it('keeps Ctrl and drops Meta when a combo claims both', () => {
    expect(parseCombo('Ctrl+Cmd+Enter')).toMatchObject({ ctrl: true, meta: false })
  })

  it('accepts named keys, function keys and punctuation', () => {
    expect(parseCombo('Escape')?.key).toBe('Escape')
    expect(parseCombo('Esc')?.key).toBe('Escape')
    expect(parseCombo('Return')?.key).toBe('Enter')
    expect(parseCombo('Space')?.key).toBe('Space')
    expect(parseCombo('Up')?.key).toBe('ArrowUp')
    expect(parseCombo('F12')?.key).toBe('F12')
    expect(parseCombo('Ctrl+/')?.key).toBe('/')
    expect(parseCombo('Ctrl+1')?.key).toBe('1')
  })

  it('rejects unusable combos instead of guessing', () => {
    expect(parseCombo('')).toBeNull()
    expect(parseCombo('Ctrl+')).toBeNull()
    expect(parseCombo('+Enter')).toBeNull()
    expect(parseCombo('Ctrl+Enter+F5')).toBeNull()
    expect(parseCombo('Ctrl+Shift')).toBeNull()
    expect(parseCombo('Ctrl+F25')).toBeNull()
    expect(parseCombo('Ctrl+Hyper')).toBeNull()
  })

  it('formats modifiers in canonical order', () => {
    expect(formatCombo({ ctrl: false, alt: false, shift: false, meta: false, key: 'Escape' })).toBe('Escape')
    expect(formatCombo({ ctrl: true, alt: true, shift: true, meta: true, key: 'E' })).toBe('Ctrl+Alt+Shift+Meta+E')
    expect(formatCombo({ ctrl: false, alt: true, shift: false, meta: false, key: 'Enter' })).toBe('Alt+Enter')
  })

  it('normalizes case and order', () => {
    expect(normalizeCombo('shift+ctrl+e')).toBe('Ctrl+Shift+E')
    expect(normalizeCombo('cmd+alt+l')).toBe('Alt+Meta+L')
    expect(normalizeCombo('Escape')).toBe('Escape')
    expect(normalizeCombo('not a combo')).toBeNull()
  })

  it('shows unparseable stored text as-is', () => {
    expect(displayCombo('ctrl+enter')).toBe('Ctrl+Enter')
    expect(displayCombo('garbage')).toBe('garbage')
  })
})

describe('recording a combo from a keydown event', () => {
  it('formats the pressed chord', () => {
    expect(comboFromEvent({ key: 'e', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+E')
    expect(comboFromEvent({ key: 'Enter', metaKey: true })).toBe('Meta+Enter')
    expect(comboFromEvent({ key: 'Escape' })).toBe('Escape')
    expect(comboFromEvent({ key: ' ', ctrlKey: true })).toBe('Ctrl+Space')
  })

  it('accepts named keys such as Enter and Tab as bindings', () => {
    expect(comboFromEvent({ key: 'Enter' })).toBe('Enter')
    expect(comboFromEvent({ key: 'Tab' })).toBe('Tab')
    expect(comboFromEvent({ key: 'Tab', shiftKey: true })).toBe('Shift+Tab')
  })

  it('drops Shift when the character already encodes it', () => {
    expect(comboFromEvent({ key: '?', shiftKey: true })).toBeNull()
    expect(comboFromEvent({ key: '?', ctrlKey: true, shiftKey: true })).toBe('Ctrl+?')
  })

  it('ignores modifier-only presses and bare typing keys', () => {
    for (const key of ['Control', 'Shift', 'Alt', 'Meta', '']) {
      expect(comboFromEvent({ key })).toBeNull()
    }
    expect(comboFromEvent({ key: 'a' })).toBeNull()
    expect(comboFromEvent({ key: '1' })).toBeNull()
  })

  it('normalizes a Meta chord reported together with Ctrl', () => {
    expect(comboFromEvent({ key: 'k', ctrlKey: true, metaKey: true })).toBe('Ctrl+K')
  })
})

describe('conflicts', () => {
  it('finds no conflict in the defaults', () => {
    expect(conflictOf(DEFAULT_SHORTCUTS)).toEqual([])
  })

  it('reports every action sharing a combo', () => {
    const settings = { ...DEFAULT_SHORTCUTS, format: 'Ctrl+Enter', expandStar: 'ctrl+enter' }

    expect(conflictOf(settings)).toEqual(['run', 'format', 'expandStar'])
  })

  it('reports both sides of one duplicate pair and ignores invalid combos', () => {
    const settings = { ...DEFAULT_SHORTCUTS, rerun: 'Ctrl+Shift+P', cancel: 'Ctrl+' }

    expect(conflictOf(settings)).toEqual(['rerun', 'palette'])
  })

  it('includes the completion chords in conflict detection', () => {
    const settings = { ...DEFAULT_SHORTCUTS, format: 'Enter' }

    expect(conflictOf(settings)).toEqual(['format', 'acceptCompletion'])
    expect(conflictOf({ ...DEFAULT_SHORTCUTS, run: 'Ctrl+Space' })).toEqual(['run', 'complete'])
  })
})

describe('settings normalization', () => {
  it('returns the defaults for non-objects', () => {
    expect(normalizeSettings(null)).toBe(DEFAULT_SHORTCUTS)
    expect(normalizeSettings('nope')).toBe(DEFAULT_SHORTCUTS)
    expect(normalizeSettings([])).toBe(DEFAULT_SHORTCUTS)
    expect(normalizeSettings(42)).toBe(DEFAULT_SHORTCUTS)
  })

  it('merges a partial document with the defaults', () => {
    const settings = normalizeSettings({ run: 'ctrl+enter', format: 7, rerun: 'Ctrl+', unknown: 'x' })

    expect(settings).toEqual({
      ...DEFAULT_SHORTCUTS,
      run: 'Ctrl+Enter',
      format: DEFAULT_SHORTCUTS.format,
      rerun: DEFAULT_SHORTCUTS.rerun,
    })
  })

  it('replaces one action, rejecting an unusable combo', () => {
    const next = withShortcut(DEFAULT_SHORTCUTS, 'run', 'alt+r')

    expect(next.run).toBe('Alt+R')
    expect(next.cancel).toBe('Escape')
    expect(withShortcut(DEFAULT_SHORTCUTS, 'run', 'nope')).toBe(DEFAULT_SHORTCUTS)
  })
})

describe('persistence', () => {
  it('round-trips settings through the injected storage', () => {
    const { storage, writes } = storageDouble()

    expect(saveSettings(DEFAULT_SHORTCUTS, storage)).toBe(true)
    expect(writes[0]?.key).toBe(SHORTCUTS_STORAGE_KEY)
    expect(loadSettings(storage)).toEqual(DEFAULT_SHORTCUTS)
  })

  it('normalizes on save, so hand-built maps cannot persist junk', () => {
    const { storage, records } = storageDouble()

    expect(saveSettings({ ...DEFAULT_SHORTCUTS, run: 'shift+alt+f5' }, storage)).toBe(true)
    expect(JSON.parse(records.get(SHORTCUTS_STORAGE_KEY) ?? '{}')).toMatchObject({ run: 'Alt+Shift+F5' })
  })

  it('falls back to defaults without storage, for an empty key and for corrupt JSON', () => {
    expect(loadSettings(null)).toBe(DEFAULT_SHORTCUTS)
    expect(saveSettings(DEFAULT_SHORTCUTS, null)).toBe(false)

    expect(loadSettings(storageDouble().storage)).toBe(DEFAULT_SHORTCUTS)
    expect(loadSettings(storageDouble({ [SHORTCUTS_STORAGE_KEY]: '{not json' }).storage)).toBe(DEFAULT_SHORTCUTS)
  })

  it('merges a partially stored document', () => {
    const { storage } = storageDouble({ [SHORTCUTS_STORAGE_KEY]: JSON.stringify({ run: 'ctrl+r', cancel: 'nope' }) })

    expect(loadSettings(storage)).toEqual({ ...DEFAULT_SHORTCUTS, run: 'Ctrl+R' })
  })

  it('survives a storage that throws in either direction', () => {
    expect(loadSettings(storageDouble({}, { get: new Error('denied') }).storage)).toBe(DEFAULT_SHORTCUTS)
    expect(saveSettings(DEFAULT_SHORTCUTS, storageDouble({}, { set: new Error('quota') }).storage)).toBe(false)
  })

  it('uses localStorage when it exists and tolerates denied access', () => {
    const { storage } = storageDouble({ [SHORTCUTS_STORAGE_KEY]: JSON.stringify({ run: 'Ctrl+R' }) })
    vi.stubGlobal('localStorage', storage)

    expect(loadSettings().run).toBe('Ctrl+R')
    expect(saveSettings({ ...DEFAULT_SHORTCUTS, run: 'Ctrl+R' })).toBe(true)

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied')
      },
    })
    expect(loadSettings()).toBe(DEFAULT_SHORTCUTS)
    expect(saveSettings(DEFAULT_SHORTCUTS)).toBe(false)

    vi.unstubAllGlobals()
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('falls back when localStorage is absent too', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage

    expect(loadSettings()).toBe(DEFAULT_SHORTCUTS)
    expect(saveSettings(DEFAULT_SHORTCUTS)).toBe(false)
  })
})

describe('CodeMirror key specs', () => {
  it('mirrors Ctrl chords to Cmd and Meta chords to Ctrl', () => {
    expect(keySpecs('Ctrl+Shift+E')).toEqual(['Ctrl-Shift-e', 'Cmd-Shift-e'])
    expect(keySpecs('Alt+L')).toEqual(['Alt-l'])
    expect(keySpecs('Escape')).toEqual(['Escape'])
    expect(keySpecs('Ctrl+Space')).toEqual(['Ctrl-Space', 'Cmd-Space'])
    expect(keySpecs('Meta+Enter')).toEqual(['Cmd-Enter', 'Ctrl-Enter'])
    expect(keySpecs('Shift+F5')).toEqual(['Shift-F5'])
  })

  it('binds the completion chords as plain key names', () => {
    expect(keySpecs('Ctrl+Space')).toEqual(['Ctrl-Space', 'Cmd-Space'])
    expect(keySpecs('Enter')).toEqual(['Enter'])
    expect(keySpecs('Tab')).toEqual(['Tab'])
  })

  it('returns nothing for an unparseable combo', () => {
    expect(keySpecs('nope')).toEqual([])
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { localStorage?: unknown }).localStorage
})


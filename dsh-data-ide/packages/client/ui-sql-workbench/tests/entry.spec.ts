// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindOpenShortcut, isOpenWorkbenchShortcut } from '../src/client/entry.ts'

const press = (init: KeyboardEventInit): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', init))
}

describe('isOpenWorkbenchShortcut', () => {
  it('accepts Ctrl+Shift+L and Cmd+Shift+L, any letter case', () => {
    expect(isOpenWorkbenchShortcut({ key: 'l', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe(true)
    expect(isOpenWorkbenchShortcut({ key: 'L', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe(true)
    expect(isOpenWorkbenchShortcut({ key: 'l', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false })).toBe(true)
  })

  it('rejects a bare letter and any missing modifier', () => {
    expect(isOpenWorkbenchShortcut({ key: 'l', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe(false)
    expect(isOpenWorkbenchShortcut({ key: 'l', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe(false)
    expect(isOpenWorkbenchShortcut({ key: 'l', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false })).toBe(false)
  })

  it('leaves Alt combinations to the OS', () => {
    expect(isOpenWorkbenchShortcut({ key: 'l', ctrlKey: true, metaKey: false, shiftKey: true, altKey: true })).toBe(false)
  })
})

describe('bindOpenShortcut', () => {
  let dispose: (() => void) | undefined

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('opens on the shortcut and swallows the key', () => {
    const open = vi.fn()
    dispose = bindOpenShortcut(open)

    let defaultPrevented = false
    const event = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, shiftKey: true, cancelable: true })
    window.dispatchEvent(event)
    defaultPrevented = event.defaultPrevented

    expect(open).toHaveBeenCalledTimes(1)
    expect(defaultPrevented).toBe(true)
  })

  it('ignores other keys', () => {
    const open = vi.fn()
    dispose = bindOpenShortcut(open)

    press({ key: 'k', ctrlKey: true, shiftKey: true })

    expect(open).not.toHaveBeenCalled()
  })

  it('stops listening once disposed', () => {
    const open = vi.fn()
    const stop = bindOpenShortcut(open)
    stop()

    press({ key: 'l', ctrlKey: true, shiftKey: true })

    expect(open).not.toHaveBeenCalled()
  })
})

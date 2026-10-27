// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindOpenShortcut, isEditingTarget, isOpenWorkbenchShortcut } from '../src/client/entry.ts'

const press = (init: KeyboardEventInit): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', init))
}

describe('isEditingTarget', () => {
  it('ignores keys aimed at the editor, inputs and contenteditable nodes', () => {
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    const inner = document.createElement('div')
    editor.append(inner)
    document.body.append(editor)

    const input = document.createElement('input')
    const area = document.createElement('textarea')
    const editable = document.createElement('div')
    Object.defineProperty(editable, 'isContentEditable', { value: true })

    expect(isEditingTarget(inner)).toBe(true)
    expect(isEditingTarget(input)).toBe(true)
    expect(isEditingTarget(area)).toBe(true)
    expect(isEditingTarget(editable)).toBe(true)
    expect(isEditingTarget(document.body)).toBe(false)
    expect(isEditingTarget(null)).toBe(false)
    expect(isEditingTarget(window)).toBe(false)
    // A hostile non-Element (closest throws) is treated as a global target.
    expect(isEditingTarget({ closest: () => { throw new Error('nope') } } as unknown as EventTarget)).toBe(false)
    editor.remove()
  })
})

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

  it('yields the same chord to the editor when focus is inside it', () => {
    const open = vi.fn()
    dispose = bindOpenShortcut(open)
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    document.body.append(editor)

    const event = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
    editor.dispatchEvent(event)

    expect(open).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    editor.remove()
  })

  it('stops listening once disposed', () => {
    const open = vi.fn()
    const stop = bindOpenShortcut(open)
    stop()

    press({ key: 'l', ctrlKey: true, shiftKey: true })

    expect(open).not.toHaveBeenCalled()
  })
})

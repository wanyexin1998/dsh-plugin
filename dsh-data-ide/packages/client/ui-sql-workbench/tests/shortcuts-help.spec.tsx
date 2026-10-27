// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ShortcutsHelp } from '../src/client/components/ShortcutsHelp.tsx'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('ShortcutsHelp', () => {
  it('renders nothing while closed', () => {
    act(() => {
      root.render(<ShortcutsHelp open={false} onClose={vi.fn()} />)
    })
    expect(container.querySelector('[data-shortcuts-help]')).toBeNull()
  })

  it('lists every shortcut group', () => {
    act(() => {
      root.render(<ShortcutsHelp open onClose={vi.fn()} />)
    })
    const text = container.textContent ?? ''
    expect(text).toContain('快捷键')
    expect(text).toContain('Ctrl/Cmd + Enter')
    expect(text).toContain('Ctrl/Cmd + Shift + P')
    expect(text).toContain('Ctrl/Cmd + Space')
    expect(text).toContain('Enter / Tab')
    expect(text).toContain('接受补全')
    expect(text).toContain('对象树：打开数据 / 查看 DDL')
  })

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn()
    act(() => {
      root.render(<ShortcutsHelp open onClose={onClose} />)
    })
    act(() => {
      container
        .querySelector('[data-shortcuts-overlay]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    // Other keys are ignored.
    act(() => {
      container
        .querySelector('[data-shortcuts-overlay]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'x' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    act(() => {
      container.querySelector('[aria-label="关闭快捷键说明"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

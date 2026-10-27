// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CommandPalette } from '../src/client/components/CommandPalette.tsx'
import type { CommandAction } from '../src/client/commands.ts'

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

const run = vi.fn()
const actions: readonly CommandAction[] = [
  { id: 'run', title: '执行光标语句', keywords: 'Ctrl+Enter', run },
  { id: 'format', title: '格式化 SQL', keywords: 'Ctrl+Alt+L', run: () => undefined },
]

function render(open: boolean, onClose = vi.fn()): { onClose: () => void } {
  act(() => {
    root.render(<CommandPalette open={open} actions={actions} onClose={onClose} />)
  })
  return { onClose }
}

const byLabel = (label: string): HTMLElement | undefined =>
  [...container.querySelectorAll(`[aria-label="${label}"]`)][0] as HTMLElement | undefined

const setInput = (value: string): void => {
  const input = byLabel('搜索命令') as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const key = (init: KeyboardEventInit): void => {
  act(() => {
    byLabel('搜索命令')?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  })
}

describe('CommandPalette', () => {
  it('renders nothing while closed', () => {
    render(false)
    expect(container.querySelector('[data-command-palette]')).toBeNull()
  })

  it('lists commands, filters them and shows keywords', () => {
    render(true)
    expect(container.querySelectorAll('[data-command-id]')).toHaveLength(2)
    expect(container.textContent).toContain('Ctrl+Enter')
    setInput('格式')
    const rows = [...container.querySelectorAll('[data-command-id]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-command-id')).toBe('format')
  })

  it('runs the selected command on Enter and closes first', () => {
    const onClose = vi.fn()
    render(true, onClose)
    key({ key: 'Enter' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('moves with arrows (wrapping) and Esc closes', () => {
    const onClose = vi.fn()
    render(true, onClose)
    key({ key: 'ArrowDown' })
    key({ key: 'ArrowDown' })
    // Two rows: the second Down wraps back to the first.
    expect(container.querySelector('[aria-selected="true"]')?.getAttribute('data-command-id')).toBe('run')
    key({ key: 'ArrowUp' })
    expect(container.querySelector('[aria-selected="true"]')?.getAttribute('data-command-id')).toBe('format')
    key({ key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('runs a clicked row and reports an empty result set', () => {
    render(true)
    act(() => {
      container.querySelector('[data-command-id="run"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(run).toHaveBeenCalled()

    setInput('zzz')
    expect(container.textContent).toContain('没有匹配的命令')
    key({ key: 'ArrowDown' })
    key({ key: 'Enter' })
  })

  it('selects on hover', () => {
    render(true)
    act(() => {
      container.querySelector('[data-command-id="format"]')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(container.querySelector('[aria-selected="true"]')?.getAttribute('data-command-id')).toBe('format')
  })

  it('omits the keyword span when a command has none and ignores other keys', () => {
    act(() => {
      root.render(
        <CommandPalette
          open
          actions={[{ id: 'plain', title: '纯命令', run: () => undefined }]}
          onClose={vi.fn()}
        />,
      )
    })
    expect(container.textContent).toContain('纯命令')
    key({ key: 'x' })
  })
})

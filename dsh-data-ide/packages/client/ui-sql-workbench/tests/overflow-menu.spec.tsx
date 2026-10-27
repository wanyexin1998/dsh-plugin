// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OverflowMenu, menuBox } from '../src/client/components/OverflowMenu.tsx'

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

describe('menuBox', () => {
  it('opens downward and clamps the left edge into the viewport', () => {
    const below = menuBox({ top: 20, bottom: 40, right: 30 }, { width: 400, height: 600 })
    expect(below.top).toBe(40)
    expect(below.left).toBe(8)
    expect(below.maxHeight).toBe(320)

    const squeezed = menuBox({ top: 10, bottom: 20, right: 500 }, { width: 100, height: 40 })
    expect(squeezed.left).toBe(8)
    expect(squeezed.maxHeight).toBe(80)
  })

  it('opens upward when there is more room above the anchor', () => {
    const box = menuBox({ top: 500, bottom: 520, right: 400 }, { width: 800, height: 540 })
    expect(box.top).toBe(180)
    expect(menuBox({ top: 58, bottom: 70, right: 200 }, { width: 800, height: 80 }).top).toBe(8)
    expect(box.maxHeight).toBe(320)
    expect(box.left).toBe(232)
  })
})

describe('OverflowMenu', () => {
  function render(marker?: string): { ran: number } {
    const calls = { ran: 0 }
    act(() => {
      root.render(
        <OverflowMenu label="更多" ariaLabel="更多操作" {...(marker === undefined ? {} : { marker })}>
          <button type="button" aria-label="执行全部" onClick={() => { calls.ran += 1 }}>全部</button>
          <select aria-label="导出格式"><option>CSV</option></select>
        </OverflowMenu>,
      )
    })
    return calls
  }

  it('opens a fixed menu, runs an item, and leaves a select open', () => {
    const calls = render('agent-history')
    const button = container.querySelector('[data-sql-agent-history]') as HTMLButtonElement
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[role="menu"]')).toBeNull()

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const menu = document.querySelector('[data-sql-agent-history-menu]') as HTMLDivElement
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(menu.style.top).not.toBe('')
    expect(menu.className).toContain('anchoredMenu')

    act(() => {
      menu.querySelector('select')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).not.toBeNull()

    act(() => {
      menu.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(calls.ran).toBe(1)
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('closes on escape, outside press, and a second click, and ignores other keys', () => {
    render()
    const button = container.querySelector('[aria-label="更多操作"]') as HTMLButtonElement
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const menu = document.querySelector('[role="menu"]') as HTMLDivElement

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    })
    expect(document.querySelector('[role="menu"]')).not.toBeNull()

    act(() => {
      menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).not.toBeNull()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('scroll'))
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})

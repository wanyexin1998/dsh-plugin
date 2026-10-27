// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ShortcutSettings } from '../src/client/components/ShortcutSettings.tsx'
import { DEFAULT_SHORTCUTS, SHORTCUT_META } from '../src/client/shortcut-settings.ts'
import type { ShortcutSettings as Settings } from '../src/client/shortcut-settings.ts'

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
  vi.restoreAllMocks()
})

interface RenderOptions {
  readonly open?: boolean
  readonly value?: Settings
}

function render(options: RenderOptions = {}) {
  const onChange = vi.fn()
  const onClose = vi.fn()
  act(() => {
    root.render(
      <ShortcutSettings open={options.open ?? true} value={options.value ?? DEFAULT_SHORTCUTS} onChange={onChange} onClose={onClose} />,
    )
  })
  const byLabel = (label: string): HTMLElement | undefined =>
    [...container.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === label) as HTMLElement | undefined
  const row = (action: string): HTMLElement | undefined =>
    container.querySelector(`[data-sql-shortcut-row="${action}"]`) as HTMLElement | undefined
  const combo = (action: string): string => row(action)?.querySelector('[data-sql-shortcut-combo]')?.textContent ?? ''
  const press = (init: KeyboardEventInit): void => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    })
  }
  const click = (target: Element | null | undefined): void => {
    act(() => {
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  return { onChange, onClose, byLabel, row, combo, press, click }
}

describe('shortcut settings sheet', () => {
  it('renders nothing while closed', () => {
    render({ open: false })

    expect(container.querySelector('[data-sql-shortcut-settings]')).toBeNull()
  })

  it('lists every action in its group with the current chord', () => {
    render()

    expect(container.querySelectorAll('[data-sql-shortcut-row]')).toHaveLength(SHORTCUT_META.length)
    expect(container.textContent).toContain('编辑器')
    expect(container.textContent).toContain('全局')
    expect(container.querySelectorAll('[data-sql-shortcut-group]')).toHaveLength(2)
    for (const meta of SHORTCUT_META) {
      expect(container.textContent).toContain(meta.label)
      expect(container.textContent).toContain(DEFAULT_SHORTCUTS[meta.action])
    }
    expect(container.querySelector('[data-sql-shortcut-conflict]')).toBeNull()
    expect(container.querySelector('[data-sql-shortcut-hint]')?.textContent).toContain('Esc 取消录制')
  })

  it('records a new chord for the armed action', () => {
    const view = render()

    view.click(view.byLabel('录制 执行光标所在语句'))
    expect(view.combo('run')).toBe('按下新键…')
    expect(view.byLabel('取消录制 执行光标所在语句')?.getAttribute('aria-pressed')).toBe('true')

    view.press({ key: 'k', ctrlKey: true, shiftKey: true })

    expect(view.onChange).toHaveBeenCalledTimes(1)
    expect(view.onChange.mock.calls[0]?.[0]).toEqual({ ...DEFAULT_SHORTCUTS, run: 'Ctrl+Shift+K' })
    expect(view.combo('run')).toBe(DEFAULT_SHORTCUTS.run)
    expect(view.byLabel('录制 执行光标所在语句')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('records into a second action after the first one', () => {
    const view = render()

    view.click(view.byLabel('录制 格式化 SQL'))
    view.press({ key: 'f', altKey: true })

    expect(view.onChange.mock.calls[0]?.[0]).toMatchObject({ format: 'Alt+F' })
  })

  it('cancels recording with Escape without closing the sheet', () => {
    const view = render()
    view.click(view.byLabel('录制 执行光标所在语句'))

    view.press({ key: 'Escape' })

    expect(view.onChange).not.toHaveBeenCalled()
    expect(view.onClose).not.toHaveBeenCalled()
    expect(view.combo('run')).toBe(DEFAULT_SHORTCUTS.run)
    expect(view.byLabel('录制 执行光标所在语句')).toBeDefined()
  })

  it('closes on Escape when nothing is being recorded', () => {
    const view = render()

    view.press({ key: 'Escape' })

    expect(view.onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated keys and bare typing while idle', () => {
    const view = render()

    view.press({ key: 'a' })

    expect(view.onClose).not.toHaveBeenCalled()
    expect(view.onChange).not.toHaveBeenCalled()
  })

  it('keeps waiting while only a modifier or a bare letter is pressed', () => {
    const view = render()
    view.click(view.byLabel('录制 执行光标所在语句'))

    view.press({ key: 'Shift' })
    view.press({ key: 'a' })

    expect(view.onChange).not.toHaveBeenCalled()
    expect(view.combo('run')).toBe('按下新键…')
  })

  it('cancels recording by clicking the button again', () => {
    const view = render()
    view.click(view.byLabel('录制 打开查询历史'))

    view.click(view.byLabel('取消录制 打开查询历史'))

    expect(view.combo('history')).toBe(DEFAULT_SHORTCUTS.history)
    expect(view.onChange).not.toHaveBeenCalled()
  })

  it('marks both sides of a duplicate chord and explains the conflict', () => {
    const view = render({ value: { ...DEFAULT_SHORTCUTS, format: DEFAULT_SHORTCUTS.run } })

    expect(container.querySelectorAll('[data-sql-shortcut-conflict]')).toHaveLength(2)
    expect(view.row('run')?.getAttribute('data-conflict')).toBe('true')
    expect(view.row('format')?.getAttribute('data-conflict')).toBe('true')
    expect(view.row('cancel')?.getAttribute('data-conflict')).toBe('false')
    expect(container.querySelector('[data-sql-shortcut-hint]')?.textContent).toContain('存在重复键位')
  })

  it('records Enter and Tab as candidate keys, not as confirmation', () => {
    const view = render()

    const accept = view.byLabel('录制 接受补全（回车）')
    view.click(accept)
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => {
      accept?.dispatchEvent(enter)
    })

    expect(enter.defaultPrevented).toBe(true)
    expect(view.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SHORTCUTS, acceptCompletion: 'Enter' })
    expect(view.onClose).not.toHaveBeenCalled()

    const completeButton = view.byLabel('录制 唤起代码补全')
    view.click(completeButton)
    act(() => {
      completeButton?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    })

    expect(view.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SHORTCUTS, complete: 'Tab' })
  })

  it('restores the defaults', () => {
    const view = render({ value: { ...DEFAULT_SHORTCUTS, run: 'Alt+R' } })
    expect(view.combo('run')).toBe('Alt+R')

    view.click(container.querySelector('[data-sql-shortcut-reset]'))

    expect(view.onChange).toHaveBeenCalledWith(DEFAULT_SHORTCUTS)
  })

  it('closes from the close button', () => {
    const view = render()

    view.click(view.byLabel('关闭快捷键设置'))

    expect(view.onClose).toHaveBeenCalledTimes(1)
  })
})

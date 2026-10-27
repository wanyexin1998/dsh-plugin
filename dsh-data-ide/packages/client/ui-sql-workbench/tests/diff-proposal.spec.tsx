// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DiffProposal } from '../src/client/components/DiffProposal.tsx'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const componentPath = resolve(packageRoot, 'src/client/components/DiffProposal.tsx')

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

interface RenderOptions {
  readonly open?: boolean
  readonly original?: string
  readonly proposal?: string
  readonly onAccept?: (sql: string) => void
  readonly onReject?: () => void
}

function render(options: RenderOptions = {}): {
  readonly onAccept: ReturnType<typeof vi.fn>
  readonly onReject: ReturnType<typeof vi.fn>
} {
  const onAccept = vi.fn(options.onAccept ?? (() => undefined))
  const onReject = vi.fn(options.onReject ?? (() => undefined))
  act(() => {
    root.render(
      <DiffProposal
        open={options.open ?? true}
        original={options.original ?? 'a\nb'}
        proposal={options.proposal ?? 'a\nc'}
        onAccept={onAccept}
        onReject={onReject}
      />,
    )
  })
  return { onAccept, onReject }
}

const query = (selector: string): HTMLElement | null => container.querySelector<HTMLElement>(selector)
const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-diff-line]')]

describe('DiffProposal', () => {
  it('renders nothing while closed', () => {
    render({ open: false })
    expect(query('[data-diff-proposal]')).toBeNull()
  })

  it('shows the title, the +N/-M statistics and one diff row per line', () => {
    render({ original: 'a\nb', proposal: 'a\nc' })
    expect(query('[data-diff-title]')?.textContent).toBe('Agent 提案')
    expect(query('[data-diff-stat-add]')?.textContent).toBe('+1')
    expect(query('[data-diff-stat-del]')?.textContent).toBe('-1')
    expect(rows().map(row => row.dataset['diffLineType'])).toEqual(['same', 'del', 'add'])
    expect(query('[data-diff-proposal]')?.getAttribute('role')).toBe('dialog')
    expect(query('[data-diff-proposal]')?.getAttribute('aria-label')).toBe('Agent 提案')
  })

  it('keeps authored whitespace in the rendered lines', () => {
    render({ original: 'SELECT\n  1', proposal: 'SELECT\n   1' })
    const [same, deleted, added] = rows().map(row => [...row.querySelectorAll('span')][1]?.textContent)
    expect(same).toBe('SELECT')
    expect(deleted).toBe('  1')
    expect(added).toBe('   1')
  })

  it('renders an unchanged proposal as same-only rows with zero statistics', () => {
    render({ original: 'SELECT 1', proposal: 'SELECT 1' })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.dataset['diffLineType']).toBe('same')
    expect(query('[data-diff-stat-add]')?.textContent).toBe('+0')
    expect(query('[data-diff-stat-del]')?.textContent).toBe('-0')
    expect(query('[data-diff-empty]')).toBeNull()
  })

  it('shows the empty state when both texts are empty', () => {
    render({ original: '', proposal: '' })
    expect(rows()).toHaveLength(0)
    expect(query('[data-diff-empty]')?.textContent).toBe('SQL 没有变化。')
  })

  it('caps its height by capping the card and scrolling the diff body', () => {
    render()
    const card = query('[data-diff-proposal]')
    const body = query('[data-diff-body]')
    expect(card?.style.maxHeight).toBe('100%')
    expect(body?.style.overflow).toBe('auto')
    expect(body?.style.maxHeight).toBe('46vh')
  })

  it('accepts with the reconstructed proposal text', () => {
    const proposal = 'a\nc\nd\n'
    const { onAccept } = render({ original: 'a\nb\n', proposal })
    act(() => {
      query('[data-diff-accept]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onAccept).toHaveBeenCalledWith(proposal)
  })

  it('rejects from the button', () => {
    const { onReject } = render()
    act(() => {
      query('[data-diff-reject]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('treats Escape as reject and ignores other keys', () => {
    const { onReject } = render()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    })
    expect(onReject).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('removes the Escape listener when it closes or unmounts', () => {
    const { onReject } = render()
    act(() => {
      root.render(
        <DiffProposal open={false} original="a" proposal="b" onAccept={() => undefined} onReject={onReject} />,
      )
    })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onReject).not.toHaveBeenCalled()
  })

  it('tints added and removed rows with theme tokens only', () => {
    const source = readFileSync(componentPath, 'utf8')
    expect(source).toContain('color-mix(in srgb, var(--dsw-alias-state-success-primary)')
    expect(source).toContain('color-mix(in srgb, var(--dsw-alias-state-error-primary)')
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(source).not.toMatch(/\brgba?\(/)
  })
})

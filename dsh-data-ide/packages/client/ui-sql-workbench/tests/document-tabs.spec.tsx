// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DocumentTabs } from '../src/client/components/DocumentTabs.tsx'
import type { DocumentTab } from '../src/client/state/documents.ts'
import { INITIAL_QUERY } from '../src/client/state/query.ts'

const tab = (id: string, title: string, connId: string | null, sql = ''): DocumentTab => ({
  id,
  title,
  connId,
  query: { ...INITIAL_QUERY, sql },
  script: null,
  lastRunSql: '',
})

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

function render(tabs: DocumentTab[], activeId: string, canCreate = true) {
  const calls = { select: [] as string[], close: [] as string[], create: [] as number[] }
  act(() => {
    root.render(
      <DocumentTabs
        tabs={tabs}
        activeId={activeId}
        connectionNames={{ c1: 'doris', c2: 'zanmal_read' }}
        onSelect={id => calls.select.push(id)}
        onClose={id => calls.close.push(id)}
        onCreate={() => calls.create.push(Date.now())}
        canCreate={canCreate}
      />,
    )
  })
  const byLabel = (label: string): HTMLElement | undefined =>
    [...container.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === label) as HTMLElement | undefined
  const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll('button')] as HTMLButtonElement[]
  return { calls, byLabel, buttons }
}

describe('document tabs', () => {
  it('renders one tab per document with the active one marked', () => {
    render([tab('a', 'console_1', 'c1'), tab('b', 'console_2', 'c2')], 'b')

    const tabs = [...container.querySelectorAll('[role="tab"]')]
    expect(tabs).toHaveLength(2)
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')
  })

  it('shows the connection name as a tooltip', () => {
    render([tab('a', 'console_1', 'c1')], 'a')

    expect(container.querySelector('[title^="doris"]')).not.toBeNull()
  })

  it('says 未连接 when the tab has no connection', () => {
    render([tab('a', 'console_1', null)], 'a')

    expect(container.querySelector('[title^="未连接"]')).not.toBeNull()
  })

  it('marks edited SQL with a star', () => {
    const tabs = [tab('a', 'console_1', 'c1', 'SELECT 1')]
    render(tabs, 'a')

    expect(container.textContent).toContain('*')
  })

  it('switches, closes and creates', () => {
    const view = render([tab('a', 'console_1', 'c1'), tab('b', 'console_2', 'c2')], 'a')

    act(() => {
      view.buttons().find(button => button.textContent === 'console_2')?.click()
    })
    act(() => {
      view.byLabel('关闭 console_1')?.click()
    })
    act(() => {
      view.byLabel('新建查询标签')?.click()
    })

    expect(view.calls.select).toEqual(['b'])
    expect(view.calls.close).toEqual(['a'])
    expect(view.calls.create).toHaveLength(1)
  })

  it('disables the add button at the tab ceiling', () => {
    const view = render([tab('a', 'console_1', 'c1')], 'a', false)

    expect((view.byLabel('新建查询标签') as HTMLButtonElement).disabled).toBe(true)
  })

  it('gives each connection a colour chip', () => {
    render([tab('a', 'console_1', 'c1'), tab('b', 'console_2', 'c2'), tab('c', 'console_3', null)], 'a')

    const chips = [...container.querySelectorAll('[role="tab"] > span[aria-hidden]')]
    expect(chips).toHaveLength(3)
  })
})

describe('document tabs: unknown connection', () => {
  it('falls back to 未连接 when the connection is gone', () => {
    render([tab('a', 'console_1', 'deleted-conn')], 'a')

    expect(container.querySelector('[title^="未连接"]')).not.toBeNull()
  })
})

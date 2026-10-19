import { describe, expect, it } from 'vitest'

import {
  MAX_TABS,
  activeTab,
  closeTab,
  connectionColor,
  createTab,
  isDirty,
  nextTitle,
  patchTab,
} from '../src/client/state/documents.ts'
import type { DocumentTab } from '../src/client/state/documents.ts'
import { INITIAL_QUERY } from '../src/client/state/query.ts'

const tab = (id: string, title: string, connId: string | null = 'c1'): DocumentTab => ({
  id,
  title,
  connId,
  query: INITIAL_QUERY,
  script: null,
  lastRunSql: '',
})

describe('titles', () => {
  it('picks the first free console number', () => {
    expect(nextTitle([])).toBe('console_1')
    expect(nextTitle([tab('a', 'console_1')])).toBe('console_2')
    expect(nextTitle([tab('a', 'console_1'), tab('b', 'console_3')])).toBe('console_2')
  })

  it('caps the number of tabs', () => {
    expect(MAX_TABS).toBeGreaterThan(1)
  })
})

describe('createTab', () => {
  it('binds the connection and starts empty', () => {
    const created = createTab([tab('a', 'console_1')], 'conn-9')

    expect(created).toMatchObject({ title: 'console_2', connId: 'conn-9', script: null })
    expect(created.query).toBe(INITIAL_QUERY)
    expect(isDirty(created)).toBe(false)
  })

  it('can be created without a connection', () => {
    expect(createTab([], null).connId).toBeNull()
  })
})

describe('patchTab', () => {
  it('replaces only the named tab', () => {
    const tabs = [tab('a', 'console_1'), tab('b', 'console_2')]

    const patched = patchTab(tabs, 'b', { connId: 'c2' })

    expect(patched[0]?.connId).toBe('c1')
    expect(patched[1]?.connId).toBe('c2')
  })

  it('accepts a function of the current tab', () => {
    const tabs = [tab('a', 'console_1')]

    expect(patchTab(tabs, 'a', current => ({ lastRunSql: current.query.sql }))[0]?.lastRunSql).toBe('')
  })

  it('leaves the list alone for an unknown id', () => {
    const tabs = [tab('a', 'console_1')]
    expect(patchTab(tabs, 'nope', { connId: 'x' })).toEqual(tabs)
  })
})

describe('activeTab', () => {
  it('falls back to the first tab', () => {
    const tabs = [tab('a', 'console_1'), tab('b', 'console_2')]
    expect(activeTab(tabs, 'b').id).toBe('b')
    expect(activeTab(tabs, 'missing').id).toBe('a')
  })
})

describe('closeTab', () => {
  it('activates the neighbour on the right, then the left', () => {
    const tabs = [tab('a', 'console_1'), tab('b', 'console_2'), tab('c', 'console_3')]

    expect(closeTab(tabs, 'b')).toMatchObject({ activeId: 'c' })
    expect(closeTab(tabs, 'c').activeId).toBe('b')
    expect(closeTab(tabs, 'a').activeId).toBe('b')
  })

  it('keeps an empty console when the last tab closes', () => {
    const result = closeTab([tab('a', 'console_1')], 'a')

    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]?.id).toBe(result.activeId)
    expect(result.tabs[0]?.query).toBe(INITIAL_QUERY)
  })
})

describe('isDirty', () => {
  it('marks edited SQL and clears it after a run', () => {
    const base = tab('a', 'console_1')
    const edited = patchTab([base], 'a', { query: { ...INITIAL_QUERY, sql: 'SELECT 1' } })[0] as DocumentTab
    expect(isDirty(edited)).toBe(true)

    const run = patchTab([edited], 'a', { lastRunSql: 'SELECT 1' })[0] as DocumentTab
    expect(isDirty(run)).toBe(false)
  })

  it('is not dirty for whitespace alone', () => {
    const blank = patchTab([tab('a', 'console_1')], 'a', { query: { ...INITIAL_QUERY, sql: '   ' } })[0] as DocumentTab
    expect(isDirty(blank)).toBe(false)
  })
})

describe('connectionColor', () => {
  it('is stable per connection and within the palette', () => {
    expect(connectionColor('conn-a')).toBe(connectionColor('conn-a'))
    for (const connId of ['a', 'b', 'c', 'd', 'e']) {
      expect(connectionColor(connId)).toBeGreaterThanOrEqual(0)
      expect(connectionColor(connId)).toBeLessThanOrEqual(3)
    }
  })

  it('has a slot for "no connection"', () => {
    expect(connectionColor(null)).toBe(0)
  })
})

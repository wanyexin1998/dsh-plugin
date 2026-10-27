// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TableOverview } from '../src/client/components/TableOverview.tsx'
import type { SchemaTable } from '../src/client/completion.ts'
import type { ExecuteResponse } from '../src/execute/core.ts'
import { overviewSampleSql, overviewStatsSql } from '../src/client/schema-tree.ts'

const order: SchemaTable = {
  schema: 'dwd',
  kind: 'table',
  name: 'dwd_order',
  columns: [
    { name: 'order_id', type: 'BIGINT' },
    { name: 'amount', type: 'DECIMAL' },
  ],
}
const loose: SchemaTable = { name: 'loose', columns: [{ name: 'id', type: 'INT' }] }
const blank: SchemaTable = { schema: '', name: 'blank', columns: [] }

const column = (name: string): { readonly name: string; readonly typeName: string } => ({ name, typeName: 'LONGLONG' })

function response(
  columns: readonly { readonly name: string; readonly typeName: string }[],
  rows: readonly unknown[][],
): ExecuteResponse {
  return { columns, rows, total: rows.length, hasNextPage: false, offset: 0, durationMs: 3, statementId: 'stmt-1' }
}

function statsResponse(total: number | null, counts: readonly (number | null)[]): ExecuteResponse {
  return response([column('总行数'), ...counts.map((_count, index) => column(`n${String(index + 1)}`))], [[total, ...counts]])
}

const sampleResponse = (): ExecuteResponse =>
  response(
    [
      { name: 'order_id', typeName: 'LONGLONG' },
      { name: 'amount', typeName: 'DECIMAL' },
    ],
    [
      [1, null],
      [2, 3.5],
    ],
  )

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

/** Let the three load promises settle inside act(). */
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

interface Mounted {
  readonly onClose: ReturnType<typeof vi.fn>
  readonly load: ReturnType<typeof vi.fn>
  readonly loadDdl: ReturnType<typeof vi.fn>
}

function render(
  load: (sql: string) => Promise<ExecuteResponse>,
  loadDdl: () => Promise<string>,
  table: SchemaTable = order,
  open = true,
): Mounted {
  const onClose = vi.fn()
  const loadSpy = vi.fn(load)
  const ddlSpy = vi.fn(loadDdl)
  act(() => {
    root.render(
      <TableOverview open={open} table={table} load={loadSpy} loadDdl={ddlSpy} onClose={onClose} />,
    )
  })
  return { onClose, load: loadSpy, loadDdl: ddlSpy }
}

const deferred = <T,>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void } => {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const element = (selector: string): HTMLElement | null => container.querySelector(selector)

describe('TableOverview', () => {
  it('renders nothing while closed and ignores Escape', () => {
    const mounted = render(() => Promise.resolve(statsResponse(0, [])), () => Promise.resolve(''), order, false)

    expect(element('[data-sql-table-overview]')).toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(mounted.onClose).not.toHaveBeenCalled()
  })

  it('shows the bounded card and loading state while the three loads are pending', () => {
    render(() => new Promise<ExecuteResponse>(() => undefined), () => new Promise<string>(() => undefined))

    const card = element('[data-sql-table-overview]')
    expect(card).not.toBeNull()
    expect(card?.style.maxHeight).toBe('78vh')
    expect(card?.style.maxWidth).toBe('min(900px, 92vw)')
    expect(element('[data-sql-table-overview-overlay]')?.style.position).toBe('fixed')
    expect(element('[data-overview-body]')?.style.overflow).toBe('auto')

    const text = container.textContent ?? ''
    expect(text).toContain('表概览 · dwd.dwd_order')
    expect(text).toContain('统计加载中…')
    expect(text).toContain('样例加载中…')
    expect(text).toContain('DDL 加载中…')
  })

  it('renders statistics, a horizontally scrollable sample and the DDL', async () => {
    const mounted = render(
      async sql => (sql === overviewStatsSql(order) ? statsResponse(100, [90, 0]) : sampleResponse()),
      async () => 'CREATE TABLE `dwd`.`dwd_order` (\n  `order_id` BIGINT\n)',
    )
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('总行数：100')
    expect(text).toContain('order_id')
    expect(text).toContain('BIGINT')
    expect(text).toContain('90')
    expect(text).toContain('10.0%')
    expect(text).toContain('100%')
    expect(text).toContain('NULL')
    expect(text).toContain('3.5')

    expect(element('[data-overview-sample-scroll]')?.style.overflowX).toBe('auto')
    expect(element('[data-overview-ddl]')?.textContent).toContain('CREATE TABLE')
    expect(element('[data-overview-ddl]')?.style.fontFamily).toBe('var(--ds-font-family-code)')

    // The dialog asks for the shared SQL builders, not hand-written statements.
    expect(mounted.load).toHaveBeenCalledWith(overviewStatsSql(order))
    expect(mounted.load).toHaveBeenCalledWith(overviewSampleSql(order))
    expect(mounted.loadDdl).toHaveBeenCalledTimes(1)
  })

  it('marks unknown counts and unknown null rates with a dash (schema-less object)', async () => {
    render(
      async sql => (sql === overviewStatsSql(loose) ? statsResponse(null, [90]) : sampleResponse()),
      async () => 'CREATE TABLE `loose` (`id` INT)',
      loose,
    )
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('表概览 · loose')
    expect(text).toContain('总行数：—')
    expect(text).toContain('—')
  })

  it('falls back to dashes when the statistics row is shorter than the column list', async () => {
    render(
      async sql => (sql === overviewStatsSql(order) ? statsResponse(null, []) : sampleResponse()),
      async () => 'CREATE TABLE `dwd`.`dwd_order` (`order_id` BIGINT)',
    )
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('总行数：—')
    expect(container.querySelectorAll('[data-overview-column]')).toHaveLength(2)
    expect(text.match(/—/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('explains that an object without column metadata can only show its total', async () => {
    render(
      async () => statsResponse(7, []),
      async () => 'CREATE VIEW `blank` AS SELECT 1',
      blank,
    )
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('表概览 · blank')
    expect(text).toContain('总行数：7')
    expect(text).toContain('该对象没有列元数据，只能显示总行数')
    expect(element('[data-overview-stats]')).toBeNull()
  })

  it('reports each section failure in words the reader can act on', async () => {
    render(
      async sql => {
        if (sql === overviewStatsSql(order)) throw new Error('统计查询被拒绝')
        throw '样例查询被拒绝'
      },
      async () => {
        throw new Error('没有权限读取 DDL')
      },
    )
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('统计加载失败：统计查询被拒绝')
    expect(text).toContain('样例加载失败：样例查询被拒绝')
    expect(text).toContain('DDL 读取失败：没有权限读取 DDL')
  })

  it('shows empty-state copy for no rows and a missing DDL', async () => {
    render(
      async sql => (sql === overviewStatsSql(order) ? statsResponse(5, [5, 5]) : response([column('a')], [])),
      async () => '',
    )
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('0%')
    expect(text).toContain('没有样例数据')
    expect(text).toContain('数据库没有返回 DDL')
  })

  it('closes on Escape and on the close button, ignoring other keys', async () => {
    const mounted = render(async () => statsResponse(0, [0, 0]), async () => 'CREATE TABLE t (id int)')
    await flush()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
    expect(mounted.onClose).not.toHaveBeenCalled()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(mounted.onClose).toHaveBeenCalledTimes(1)

    act(() => {
      element('[data-overview-close]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mounted.onClose).toHaveBeenCalledTimes(2)
  })

  it('shows the loading state again when the object changes', async () => {
    const pending = deferred<ExecuteResponse>()
    const load = vi.fn(async (sql: string): Promise<ExecuteResponse> => {
      if (sql === overviewStatsSql(order)) return statsResponse(100, [90, 0])
      if (sql === overviewSampleSql(order)) return sampleResponse()
      if (sql === overviewStatsSql(loose)) return pending.promise
      return response([column('id')], [[1]])
    })
    render(load, async () => 'CREATE TABLE `loose` (`id` INT)')
    await flush()
    expect(container.textContent).toContain('总行数：100')

    act(() => {
      root.render(
        <TableOverview open table={loose} load={load} loadDdl={async () => 'CREATE TABLE `loose` (`id` INT)'} onClose={vi.fn()} />,
      )
    })
    expect(container.textContent).toContain('统计加载中…')

    await act(async () => {
      pending.resolve(statsResponse(7, [7]))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('总行数：7')
  })

  it('drops late results from a closed dialog', async () => {
    const stats = deferred<ExecuteResponse>()
    const sample = deferred<ExecuteResponse>()
    const ddl = deferred<string>()
    const load = vi.fn((sql: string): Promise<ExecuteResponse> => (sql === overviewStatsSql(order) ? stats.promise : sample.promise))
    const loadDdl = vi.fn(() => ddl.promise)
    act(() => {
      root.render(<TableOverview open table={order} load={load} loadDdl={loadDdl} onClose={vi.fn()} />)
    })

    act(() => {
      root.render(<TableOverview open={false} table={order} load={load} loadDdl={loadDdl} onClose={vi.fn()} />)
    })
    await act(async () => {
      stats.resolve(statsResponse(1, [1, 1]))
      sample.resolve(sampleResponse())
      ddl.resolve('CREATE TABLE late (id int)')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(element('[data-sql-table-overview]')).toBeNull()
    expect(container.textContent ?? '').toBe('')
  })
})

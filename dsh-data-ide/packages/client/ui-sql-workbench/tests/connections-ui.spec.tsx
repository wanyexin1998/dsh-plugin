import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { createDataSource } from '../src/datasource/model.ts'
import { ConnectionBar } from '../src/client/components/ConnectionBar.tsx'
import { ConnectionDialog } from '../src/client/components/ConnectionDialog.tsx'
import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import { TestStateBadge } from '../src/client/components/TestStateBadge.tsx'
import { draftFor } from '../src/client/state/connections.ts'
import type { TestResult, WorkbenchApi } from '../src/client/api.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const doris = createDataSource({ id: connId, name: 'doris.shcell.com', dbms: 'doris', host: 'doris.shcell.com', username: 'wanyexin' })

const noop = (): void => undefined

const api: WorkbenchApi = {
  list: async () => [doris],
  active: async () => connId,
  setActive: async () => undefined,
  save: async draft => createDataSource({ id: connId, name: draft.name, dbms: draft.dbms, host: draft.host, port: draft.port, username: draft.username }),
  remove: async () => true,
  test: async () => ({ state: 'YES', durationMs: 10 }),
  execute: async () => ({ ok: false, error: { code: 'NOT_STUBBED', message: 'execute' } }),
  fetchPage: async () => ({ ok: false, error: { code: 'NOT_STUBBED', message: 'fetchPage' } }),
  cancel: async () => ({ cancelled: true }),
  schema: async () => ({ tables: [], fetchedAt: '1970-01-01T00:00:00.000Z', truncated: false, source: 'information_schema' as const }),
  executeScript: async () => ({ statements: [], durationMs: 0 }),
}

describe('TestStateBadge', () => {
  it('shows a pending pulse while probing', () => {
    expect(renderToStaticMarkup(<TestStateBadge busy />)).toContain('data-test-state="testing"')
  })

  it('says untested before the first run', () => {
    const html = renderToStaticMarkup(<TestStateBadge />)
    expect(html).toContain('未测试')
    expect(html).toContain('dotIdle')
  })

  it('shows product facts on success', () => {
    const result: TestResult = {
      state: 'YES',
      durationMs: 120,
      info: {
        product: 'Doris',
        version: '5.7.99',
        exactVersion: 'Doris version doris-2.1.10',
        driverVersion: 'mysql2 3.24.6',
        dbms: 'MYSQL',
        identifierQuoteString: '`',
        caseSensitivity: { plain: 'lower', quoted: 'exact' },
      },
    }

    const html = renderToStaticMarkup(<TestStateBadge result={result} />)

    expect(html).toContain('Doris 5.7.99')
    expect(html).toContain('mysql2 3.24.6')
  })

  it('falls back to a plain success line without product facts', () => {
    expect(renderToStaticMarkup(<TestStateBadge result={{ state: 'YES', durationMs: 1 }} />)).toContain('连接成功')
  })

  it('shows the failure reason and its hint', () => {
    const html = renderToStaticMarkup(
      <TestStateBadge result={{ state: 'NO', durationMs: 900, error: { code: 'AUTH_FAILED', message: 'Access denied', hint: '检查密码' } }} />,
    )

    expect(html).toContain('data-test-state="NO"')
    expect(html).toContain('Access denied')
    expect(html).toContain('检查密码')
  })

  it('renders UNSURE without a hint', () => {
    expect(renderToStaticMarkup(<TestStateBadge result={{ state: 'UNSURE', durationMs: 0 }} />)).toContain('连接失败')
  })
})

describe('ConnectionBar', () => {
  it('offers an empty affordance before any connection exists', () => {
    const html = renderToStaticMarkup(
      <ConnectionBar connections={[]} activeId={null} testingId={null} verdicts={{}} onSelect={noop} onTest={noop} onCreate={noop} onEdit={noop} onOpenShortcuts={noop} />,
    )

    expect(html).toContain('未选择连接')
    expect(html).toContain('连接操作')
    expect(html).toContain('data-test-state="idle"')
    expect(html).toContain('disabled')
  })

  it('lists connections and the active verdict', () => {
    const html = renderToStaticMarkup(
      <ConnectionBar
        connections={[doris]}
        activeId={connId}
        testingId={null}
        verdicts={{ [connId]: { state: 'YES', durationMs: 5 } }}
        onSelect={noop}
        onTest={noop}
        onCreate={noop}
        onEdit={noop}
        onOpenShortcuts={noop}
      />,
    )

    expect(html).toContain('doris.shcell.com（doris）')
    expect(html).toContain('连接成功')
    expect(html).toContain('data-test-state="YES"')
    expect(html).not.toContain('可写')
  })

  it('marks a connection that allows writes', () => {
    const writable = createDataSource({
      id: connId,
      name: 'doris.shcell.com',
      dbms: 'doris',
      host: 'doris.shcell.com',
      username: 'wanyexin',
      writeEnabled: true,
    })
    const html = renderToStaticMarkup(
      <ConnectionBar
        connections={[writable]}
        activeId={connId}
        testingId={null}
        verdicts={{}}
        onSelect={noop}
        onTest={noop}
        onCreate={noop}
        onEdit={noop}
        onOpenShortcuts={noop}
      />,
    )

    expect(html).toContain('可写')
  })

  it('marks the dot as testing while a probe is in flight', () => {
    const html = renderToStaticMarkup(
      <ConnectionBar
        connections={[doris]}
        activeId={connId}
        testingId={connId}
        verdicts={{}}
        onSelect={noop}
        onTest={noop}
        onCreate={noop}
        onEdit={noop}
        onOpenShortcuts={noop}
      />,
    )
    expect(html).toContain('data-test-state="testing"')
  })
})

describe('ConnectionDialog', () => {
  it('renders every field with engine defaults and both switches', () => {
    const html = renderToStaticMarkup(
      <ConnectionDialog title="新建连接" draft={draftFor('doris')} onChange={noop} onSubmit={noop} onCancel={noop} />,
    )

    expect(html).toContain('新建连接')
    expect(html).toContain('value="9030"')
    expect(html).toContain('仅本次会话')
    expect(html).toContain('writeEnabled')
    expect(html).not.toContain('删除')
  })

  it('marks the offending field and offers deletion when editing', () => {
    const html = renderToStaticMarkup(
      <ConnectionDialog
        title="连接配置"
        draft={{ ...draftFor('doris'), id: connId }}
        error={{ field: 'host', reason: '主机不能为空' }}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
        onDelete={noop}
      />,
    )

    expect(html).toContain('主机不能为空')
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('删除')
  })
})

describe('SqlWorkbenchPanel', () => {
  it('explains a missing host service instead of rendering a dead panel', () => {
    const html = renderToStaticMarkup(<SqlWorkbenchPanel sessionId="s1" />)

    expect(html).toContain('data-phase="unavailable"')
    expect(html).toContain('宿主服务不可用')
  })

  it('waits for the first load', () => {
    const html = renderToStaticMarkup(<SqlWorkbenchPanel sessionId="s1" api={api} />)

    expect(html).toContain('data-phase="loading"')
    expect(html).toContain('正在读取连接')
  })
})

describe('TestStateBadge success without an exact version', () => {
  it('omits the parenthetical when the server reports no build comment', () => {
    const html = renderToStaticMarkup(
      <TestStateBadge
        result={{
          state: 'YES',
          durationMs: 42,
          info: {
            product: 'MySQL',
            version: '8.0.36',
            driverVersion: 'mysql2 3.24.6',
            dbms: 'MYSQL',
            identifierQuoteString: '`',
            caseSensitivity: { plain: 'lower', quoted: 'exact' },
          },
        }}
      />,
    )

    expect(html).toContain('MySQL 8.0.36')
    expect(html).not.toContain('(')
  })
})

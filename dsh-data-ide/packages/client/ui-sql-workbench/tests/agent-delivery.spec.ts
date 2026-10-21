import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type AgentDelivery,
  fitDelivery,
  isValidLabel,
  normalizeSql,
  parseDelivery,
  sameBatch,
} from '../src/execute/agent-delivery.ts'
import { startAgentRelay } from '../src/host/agent-relay.ts'
import {
  publishConsoles,
  subscribeAgentDeliveries,
  type EventSourceLike,
} from '../src/client/agent-stream.ts'
import {
  MAX_AGENT_HISTORY,
  MAX_AGENT_TABS,
  type DocumentTab,
  applyAgentDelivery,
  archiveOverflow,
  createTab,
  isAgentPoolFull,
  markAgentRead,
  pushArchive,
  tabsForDelivery,
  takeArchived,
} from '../src/client/state/documents.ts'

/** One-page `ExecuteResponse` with a single INT column. */
function page(rows: unknown[][]) {
  return {
    columns: [{ name: 'a', typeName: 'INT' }],
    rows,
    total: rows.length,
    hasNextPage: false,
    offset: 0,
    durationMs: 1,
    statementId: 's1',
  }
}

function delivery(patch: Partial<AgentDelivery> = {}): AgentDelivery {
  return {
    schema: 1,
    id: 'd1',
    label: '月报',
    connId: 'doris',
    consoleId: null,
    sql: 'select 1 as a',
    kind: 'single',
    at: '2026-10-21T00:00:00.000Z',
    single: { ok: true, ...page([[1]]) },
    ...patch,
  }
}

describe('agent delivery envelope', () => {
  it('accepts labels safe for a tab title and rejects the rest', () => {
    expect(isValidLabel('月报-2026_10')).toBe(true)
    expect(isValidLabel('a/b')).toBe(false)
    expect(isValidLabel('')).toBe(false)
    expect(isValidLabel('x'.repeat(65))).toBe(false)
  })

  it('treats comment and whitespace differences as the same batch', () => {
    expect(normalizeSql('SELECT 1 -- note\n')).toBe('select 1')
    expect(sameBatch('select 1', 'SELECT   1 /* x */')).toBe(true)
    expect(sameBatch('select 1', 'select 2')).toBe(false)
  })

  it('drops unknown envelopes and keeps well-formed ones', () => {
    expect(parseDelivery(null)).toBeNull()
    expect(parseDelivery('delivery')).toBeNull()
    expect(parseDelivery({ nonsense: true })).toBeNull()
    expect(parseDelivery({ ...delivery(), schema: 2 })).toBeNull()
    expect(parseDelivery({ ...delivery(), label: 'bad label' })).toBeNull()
    expect(parseDelivery(JSON.parse(JSON.stringify(delivery())))?.label).toBe('月报')
  })

  it('validates every required field and optional delivery field', () => {
    for (const patch of [
      { id: 1 },
      { label: 1 },
      { connId: 1 },
      { sql: 1 },
      { at: 1 },
      { kind: 'unknown' },
    ]) {
      expect(parseDelivery({ ...delivery(), ...patch })).toBeNull()
    }
    const parsed = parseDelivery({ ...delivery(), consoleId: 'agent-1', previewRows: 100 })
    expect(parsed).toMatchObject({ consoleId: 'agent-1', previewRows: 100 })
  })

  it('drops an envelope whose page cannot be rendered', () => {
    // An unvalidated payload used to reach ResultGrid and crash it (§15 A8).
    expect(parseDelivery({ ...delivery(), single: { ok: true, columns: [], rows: 'nope' } })).toBeNull()
    expect(parseDelivery({ ...delivery(), kind: 'script' })).toBeNull()
    expect(parseDelivery({ ...delivery(), single: { ok: false, error: 'nope' } })).toBeNull()
    expect(parseDelivery({ ...delivery(), single: { ok: true, columns: [{}], rows: [] } })).toBeNull()
  })

  it('accepts valid script statements and drops malformed entries', () => {
    const script = [
      { index: 0, sql: 'select 1', ok: true, response: page([[1]]) },
      { index: 1, sql: 'delete x', ok: false, error: { code: 'READ_ONLY', message: '只读' } },
      { index: 'bad', sql: 'select 2', ok: true, response: page([[2]]) },
      null,
    ]
    const parsed = parseDelivery({ ...delivery(), kind: 'script', single: undefined, script })
    expect(parsed?.script).toHaveLength(2)
    expect(parseDelivery({ ...delivery(), kind: 'script', single: undefined, script: [null] })).toBeNull()
    expect(parseDelivery({ ...delivery(), kind: 'script', single: undefined, script: {} })).toBeNull()
  })

  it('shrinks an oversized payload to a preview page', () => {
    const big = delivery({
      single: { ok: true, ...page(Array.from({ length: 5000 }, () => ['x'.repeat(4096)])) },
    })
    const fitted = fitDelivery(big)
    expect(fitted.previewRows).toBe(100)
    expect(fitted.single?.ok === true && fitted.single.rows.length).toBe(100)
  })

  it('shrinks script pages but leaves refusals and payloads without results alone', () => {
    const rows = Array.from({ length: 5000 }, () => ['宽'.repeat(4096)])
    const oversized = delivery({
      kind: 'script',
      single: undefined,
      script: [
        { index: 0, sql: 'select 1', ok: true, response: page(rows) },
        { index: 1, sql: 'delete x', ok: false, error: { code: 'READ_ONLY', message: '只读' } },
      ],
    })
    const fitted = fitDelivery(oversized)
    expect(fitted.previewRows).toBe(100)
    expect(fitted.script?.[0]?.response?.rows).toHaveLength(100)
    expect(fitted.script?.[1]?.response).toBeUndefined()

    const withoutResult = { ...delivery(), single: undefined, sql: '宽'.repeat(3_000_000) } as AgentDelivery
    expect(fitDelivery(withoutResult)).toBe(withoutResult)

    const refused = delivery({
      single: { ok: false, error: { code: 'READ_ONLY', message: '只读' } },
      sql: '宽'.repeat(3_000_000),
    })
    expect(fitDelivery(refused).single).toEqual(refused.single)

    const scriptWithoutResults = delivery({
      kind: 'script',
      single: undefined,
      script: undefined,
      sql: '宽'.repeat(3_000_000),
    })
    expect(fitDelivery(scriptWithoutResults).script).toEqual([])
  })
})

describe('applyAgentDelivery', () => {
  const base = [createTab([], 'doris')]
  const active = base[0]?.id as string

  it('opens ai_<label> without stealing focus', () => {
    const applied = applyAgentDelivery(base, active, delivery(), 1000)
    const agent = applied.tabs.find(tab => tab.owner === 'agent') as DocumentTab

    expect(applied.created).toBe(true)
    expect(applied.activeId).toBe(active)
    expect(agent.title).toBe('ai_月报')
    expect(agent.unread).toBe(true)
    expect(agent.script?.tabs).toHaveLength(1)
    expect(agent.query.sql).toBe('select 1 as a')
  })

  it('updates in place for the same label and equivalent SQL', () => {
    const first = applyAgentDelivery(base, active, delivery(), 1000)
    const again = applyAgentDelivery(first.tabs, active, delivery({ id: 'd2', sql: 'SELECT 1 AS a -- x' }), 2000)
    const agents = again.tabs.filter(tab => tab.owner === 'agent')

    expect(again.created).toBe(false)
    expect(agents).toHaveLength(1)
    expect(agents[0]?.lastActivityAt).toBe(2000)
  })

  it('opens a suffixed console when the label carries a different query', () => {
    const first = applyAgentDelivery(base, active, delivery(), 1000)
    const other = applyAgentDelivery(first.tabs, active, delivery({ id: 'd3', sql: 'select 2 as a' }), 2000)
    const titles = other.tabs.filter(tab => tab.owner === 'agent').map(tab => tab.title)

    expect(other.created).toBe(true)
    expect(titles).toContain('ai_月报')
    expect(titles).toContain('ai_月报#2')
  })

  it('keeps agent consoles instead of destroying the oldest one', () => {
    let tabs: readonly DocumentTab[] = base
    for (let index = 0; index < MAX_AGENT_TABS + 1; index += 1) {
      tabs = applyAgentDelivery(tabs, active, delivery({ id: `d${index}`, label: `批${index}` }), 1000 + index).tabs
    }
    const agents = tabs.filter(tab => tab.owner === 'agent')

    // Nothing is evicted: the "AI 历史" drawer does not exist yet (§15 A3), so
    // dropping the oldest run would lose it silently.
    expect(agents).toHaveLength(MAX_AGENT_TABS + 1)
    expect(isAgentPoolFull(tabs)).toBe(true)
  })

  it('opens a new console when the same label arrives on another connection', () => {
    const first = applyAgentDelivery(base, active, delivery(), 1000)
    const other = applyAgentDelivery(first.tabs, active, delivery({ id: 'd9', connId: 'other' }), 2000)
    const agents = other.tabs.filter(tab => tab.owner === 'agent')

    // Reusing here would show connB's rows under connA's name (§15 A1).
    expect(other.created).toBe(true)
    expect(agents).toHaveLength(2)
    expect(agents[1]?.connId).toBe('other')
  })

  it('renames a reused console that arrives under a new label', () => {
    const first = applyAgentDelivery(base, active, delivery({ label: '旧' }), 1000)
    const again = applyAgentDelivery(
      first.tabs,
      active,
      delivery({ id: 'd10', label: '新', consoleId: first.tabId }),
      2000,
    )
    const tab = again.tabs.find(entry => entry.id === first.tabId)

    expect(again.created).toBe(false)
    expect(tab?.title).toBe('ai_新')
    expect(tab?.label).toBe('新')
  })

  it('binds an explicitly reused unbound console to the delivery connection', () => {
    const first = applyAgentDelivery(base, active, delivery(), 1000)
    const unbound = first.tabs.map(tab => (tab.id === first.tabId ? { ...tab, connId: null, lastRunSql: '' } : tab))
    const again = applyAgentDelivery(unbound, active, delivery({ consoleId: first.tabId }), 2000)
    expect(again.created).toBe(false)
    expect(again.tabs.find(tab => tab.id === first.tabId)?.connId).toBe('doris')
  })

  it('converts single and script deliveries into renderable result tabs', () => {
    expect(tabsForDelivery(delivery({ single: undefined }))).toEqual([{ sql: 'select 1 as a', result: null }])
    expect(
      tabsForDelivery(delivery({ single: { ok: false, error: { code: 'READ_ONLY', message: '只读' } } }))[0],
    ).toMatchObject({ result: null, error: { code: 'READ_ONLY' } })
    const script = delivery({
      kind: 'script',
      single: undefined,
      script: [
        { index: 0, sql: 'select 1', ok: true, response: page([[1]]) },
        { index: 1, sql: 'bad', ok: false },
      ],
    })
    expect(tabsForDelivery(script)).toEqual([
      { sql: 'select 1', result: page([[1]]) },
      { sql: 'bad', result: null, error: { code: 'UNKNOWN', message: '执行失败' } },
    ])
    expect(tabsForDelivery({ ...script, script: [{ index: 0, sql: 'select 2', ok: true }] })).toEqual([
      { sql: 'select 2', result: null },
    ])
  })

  it('uses the next free suffix when two different batches share a label', () => {
    const first = applyAgentDelivery(base, active, delivery({ sql: 'select 1' }), 1000)
    const second = applyAgentDelivery(first.tabs, active, delivery({ id: 'd2', sql: 'select 2' }), 2000)
    const third = applyAgentDelivery(second.tabs, active, delivery({ id: 'd3', sql: 'select 3' }), 3000)
    expect(third.tabs.map(tab => tab.title)).toContain('ai_月报#3')
  })
})

describe('agent relay', () => {
  it('tails the spool, emits once and removes the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-outbox-'))
    const relay = await startAgentRelay({ dir, pollMs: 10 })
    const seen: string[] = []
    const off = relay.subscribe(event => seen.push(event.delivery.id))

    await writeFile(join(dir, '0000000000001-1-abc.json'), JSON.stringify(delivery()), 'utf8')
    // Wait for the envelope instead of sleeping a fixed time: a fixed delay is
    // flaky on a loaded machine (§15 A15).
    const deadline = Date.now() + 2000
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect(seen).toEqual(['d1'])
    expect(relay.cursor).toBe(1)
    expect(relay.since(0)).toHaveLength(1)
    expect(relay.since(1)).toHaveLength(0)

    off()
    await relay.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('drops corrupt and stale envelopes, isolates listeners and bounds replay history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-outbox-edges-'))
    const stale = join(dir, '0000000000000-stale.json')
    await writeFile(stale, JSON.stringify(delivery({ id: 'stale' })), 'utf8')
    await utimes(stale, new Date(0), new Date(0))
    await writeFile(join(dir, '0000000000001-bad.json'), '{', 'utf8')
    const relay = await startAgentRelay({ dir, pollMs: 5, history: 1, staleAfterMs: 1 })
    relay.subscribe(() => {
      throw new Error('listener failure')
    })
    await writeFile(join(dir, '0000000000002-ok.json'), JSON.stringify(delivery({ id: 'ok' })), 'utf8')
    await writeFile(join(dir, '0000000000003-next.json'), JSON.stringify(delivery({ id: 'next' })), 'utf8')

    const deadline = Date.now() + 2000
    while (relay.cursor < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    expect(relay.cursor).toBe(2)
    expect(relay.since(0).map(event => event.delivery.id)).toEqual(['next'])
    await expect(access(stale)).rejects.toThrow()
    await relay.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('ignores a raced stale entry that cannot be unlinked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-outbox-stale-dir-'))
    const staleDirectory = join(dir, 'stale.json')
    await mkdir(staleDirectory)
    await writeFile(join(staleDirectory, 'keep'), 'not empty', 'utf8')
    await utimes(staleDirectory, new Date(0), new Date(0))
    const relay = await startAgentRelay({ dir, pollMs: 5, staleAfterMs: 1 })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(relay.cursor).toBe(0)
    await relay.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('waits harmlessly when the spool directory does not exist', async () => {
    const dir = join(tmpdir(), `agent-outbox-missing-${Date.now()}`)
    const relay = await startAgentRelay({ dir, pollMs: 5 })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(relay.cursor).toBe(0)
    await relay.dispose()
  })

  it('skips a polling tick while the previous scan is still running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-outbox-overlap-'))
    vi.useFakeTimers()
    try {
      const relay = await startAgentRelay({ dir })
      vi.advanceTimersByTime(1001)
      await Promise.resolve()
      await relay.dispose()
    } finally {
      vi.useRealTimers()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('agent stream', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('polls the results route when no EventSource is available', async () => {
    const seen: string[] = []
    const fetchImpl = async (input: string): Promise<Response> => {
      const payload = input.includes('since=0')
        ? { ok: true, cursor: 1, events: [{ seq: 1, delivery: delivery() }] }
        : { ok: true, cursor: 1, events: [] }
      return new Response(JSON.stringify(payload), { status: 200 })
    }

    const stop = subscribeAgentDeliveries(delivery => seen.push(delivery.id), {
      pollMs: 10,
      fetchImpl,
      eventSourceImpl: null,
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    stop()

    expect(seen).toEqual(['d1'])
  })

  it('publishes console ownership and treats transport failures as advisory', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    await publishConsoles([{ id: 'u1', owner: 'user', title: 'SQL-1' }], { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/dsh-data-ide/agent-consoles',
      expect.objectContaining({ method: 'POST' }),
    )
    await expect(publishConsoles([], { fetchImpl: async () => Promise.reject(new Error('offline')) })).resolves.toBeUndefined()

    vi.stubGlobal('fetch', undefined)
    await expect(publishConsoles([])).resolves.toBeUndefined()
  })

  it('receives SSE frames, skips malformed data and falls back to polling after an error', async () => {
    class FakeEventSource implements EventSourceLike {
      static latest: FakeEventSource
      readonly listeners = new Map<string, (event: { data?: unknown }) => void>()
      readonly close = vi.fn()
      constructor(readonly url: string) {
        FakeEventSource.latest = this
      }
      addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
        this.listeners.set(type, listener)
      }
      emit(type: string, data?: unknown): void {
        this.listeners.get(type)?.({ data })
      }
    }

    const seen: string[] = []
    let polled = false
    const fetchImpl = vi.fn(async () => {
      const events = polled ? [] : [null, { delivery: delivery({ id: 'poll' }) }, { delivery: { bad: true } }]
      polled = true
      return new Response(JSON.stringify({ cursor: 2, events }), { status: 200 })
    })
    const stop = subscribeAgentDeliveries(value => seen.push(value.id), {
      pollMs: 5,
      fetchImpl,
      eventSourceImpl: FakeEventSource,
    })
    expect(FakeEventSource.latest.url).toContain('agent-events')
    FakeEventSource.latest.emit('agent-result', JSON.stringify(delivery({ id: 'sse' })))
    FakeEventSource.latest.emit('agent-result', '{')
    FakeEventSource.latest.emit('agent-result', JSON.stringify({ bad: true }))
    FakeEventSource.latest.emit('error')
    FakeEventSource.latest.emit('error')
    await new Promise(resolve => setTimeout(resolve, 25))
    stop()
    FakeEventSource.latest.emit('agent-result', JSON.stringify(delivery({ id: 'late' })))

    expect(seen).toEqual(['sse', 'poll'])
    expect(FakeEventSource.latest.close).toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('polls after EventSource construction fails and ignores bad poll responses', async () => {
    class BrokenEventSource {
      constructor() {
        throw new Error('unsupported')
      }
    }
    const replies = [
      new Response('', { status: 503 }),
      new Response('null', { status: 200 }),
      new Response(JSON.stringify({ cursor: 'bad', events: 'bad' }), { status: 200 }),
    ]
    const fetchImpl = vi.fn(async () => replies.shift() ?? Promise.reject(new Error('offline')))
    const stop = subscribeAgentDeliveries(() => undefined, {
      pollMs: 5,
      fetchImpl,
      eventSourceImpl: BrokenEventSource as never,
    })
    const deadline = Date.now() + 250
    while (fetchImpl.mock.calls.length < 4 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    stop()
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('closes an active EventSource when disposed directly', () => {
    class Source implements EventSourceLike {
      static latest: Source
      readonly close = vi.fn()
      constructor() { Source.latest = this }
      addEventListener(): void {}
    }
    const stop = subscribeAgentDeliveries(() => undefined, { eventSourceImpl: Source })
    stop()
    expect(Source.latest.close).toHaveBeenCalledOnce()
  })
})

describe('agent history', () => {
  const base = [createTab([], 'doris')]
  const active = base[0]?.id as string

  it('archives the oldest read console when the pool overflows', () => {
    let tabs: readonly DocumentTab[] = base
    for (let index = 0; index < MAX_AGENT_TABS; index += 1) {
      tabs = applyAgentDelivery(tabs, active, delivery({ id: `h${index}`, label: `批${index}` }), 1000 + index).tabs
    }
    const read = tabs.map(tab => (tab.owner === 'agent' ? { ...tab, unread: false } : tab))
    const added = applyAgentDelivery(read, active, delivery({ id: 'hx', label: '新批' }), 9999).tabs

    const overflow = archiveOverflow(added, active)
    expect(overflow.archived?.title).toBe('ai_批0')
    expect(overflow.tabs.filter(tab => tab.owner === 'agent')).toHaveLength(MAX_AGENT_TABS)

    const archive = pushArchive([], overflow.archived)
    const taken = takeArchived(archive, archive[0]?.id as string)
    expect(taken.tab?.title).toBe('ai_批0')
    expect(taken.archive).toHaveLength(0)
  })

  it('never archives an unread or the active console', () => {
    let tabs: readonly DocumentTab[] = base
    for (let index = 0; index < MAX_AGENT_TABS + 1; index += 1) {
      tabs = applyAgentDelivery(tabs, active, delivery({ id: `u${index}`, label: `未读${index}` }), 1000 + index).tabs
    }

    expect(archiveOverflow(tabs, active).archived).toBeNull()
  })

  it('keeps the history bounded', () => {
    const many = Array.from({ length: MAX_AGENT_HISTORY + 5 }, () => createTab([], 'doris'))
    let archive: readonly DocumentTab[] = []
    for (const tab of many) archive = pushArchive(archive, tab)

    expect(archive).toHaveLength(MAX_AGENT_HISTORY)
  })

  it('handles no-op archive operations and clears an unread marker', () => {
    const first = applyAgentDelivery(base, active, delivery(), 1000)
    expect(pushArchive([], null)).toEqual([])
    expect(takeArchived([], 'missing')).toEqual({ archive: [], tab: null })
    expect(markAgentRead(first.tabs, first.tabId).find(tab => tab.id === first.tabId)?.unread).toBe(false)
  })

  it('archives read consoles whose activity timestamp is absent', () => {
    let tabs: readonly DocumentTab[] = base
    for (let index = 0; index < MAX_AGENT_TABS + 1; index += 1) {
      tabs = applyAgentDelivery(tabs, active, delivery({ id: `old${index}`, label: `旧${index}` }), 1000 + index).tabs
    }
    const readWithoutTimes = tabs.map(tab =>
      tab.owner === 'agent' ? { ...tab, unread: false, lastActivityAt: undefined } : tab,
    )
    expect(archiveOverflow(readWithoutTimes, active).archived).not.toBeNull()
  })
})

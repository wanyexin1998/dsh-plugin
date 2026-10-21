import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { API_MISSING_HINT, type ConnectionDraft, type WorkbenchApi } from '../api.ts'
import {
  INITIAL_STATE,
  type PanelState,
  cancelEdit,
  draftFor,
  load,
  remove as removeConnection,
  save,
  select,
  startEdit,
  test,
  unavailable,
} from '../state/connections.ts'
import {
  INITIAL_QUERY,
  type QueryState,
  cancel as cancelQuery,
  goPage,
  run as executeQuery,
  nextSort,
  setFilters,
  setPageSize,
  setSql,
  sortBy,
} from '../state/query.ts'
import { ConnectionBar } from './ConnectionBar.tsx'
import { WorkbenchPanel, Sash } from './WorkbenchPanel.tsx'
import { ConnectionDialog } from './ConnectionDialog.tsx'
import { copyText, setCopyFailureHandler } from '../clipboard.ts'
import { readableDbError } from '../db-error.ts'
import { type DdlTarget, ddlFromRow, ddlSql, describeSchema } from '../schema-tree.ts'
import {
  EDITOR_HEIGHT_DEFAULT,
  EDITOR_HEIGHT_MIN,
  PANEL_GAP,
  RESULT_HEIGHT_MIN,
  TREE_WIDTH_DEFAULT,
  TREE_WIDTH_MIN,
  clampSize,
  maxEditorHeight,
  maxTreeWidth,
} from '../split.ts'
import type { SchemaIndex } from '../completion.ts'
import type { SchemaSnapshot } from '../../host/metadata.ts'
import { DocumentTabs } from './DocumentTabs.tsx'
import { SchemaTree } from './SchemaTree.tsx'
import { ScriptResults } from './ScriptResults.tsx'
import type { ScriptTab } from './ScriptResults.tsx'
import { splitStatements } from '../../execute/split.ts'
import type { FilterSpec, SortSpec } from '../../execute/core.ts'
import {
  type DocumentTab,
  type ScriptRun,
  MAX_TABS,
  activeTab,
  MAX_AGENT_TABS,
  applyAgentDelivery,
  archiveOverflow,
  closeTab,
  createTab,
  isAgentPoolFull,
  markAgentRead,
  patchTab,
  pushArchive,
  takeArchived,
} from '../state/documents.ts'
import { parseLayout } from '../state/layout.ts'
import { subscribeAgentDeliveries, publishConsoles } from '../agent-stream.ts'
import type { SqlEditorHandle } from './SqlEditor.tsx'
import { ResultGrid } from './ResultGrid.tsx'
import { SqlEditor } from './SqlEditor.tsx'
import { classes as styles, ensureStyles } from '../styles.ts'
import css from './sqlWorkbench.css'

/**
 * Props the right sidebar hands a mounted tab body: the session this page
 * belongs to, plus the host's tab actions.
 */
export interface SqlWorkbenchPanelProps {
  /** Session the tab belongs to; the slot runtime supplies it. */
  readonly sessionId?: string
  readonly actions?: unknown
  /** Host service; absent when the node half failed to start. */
  readonly api?: WorkbenchApi
}

interface SaveError {
  readonly field: string
  readonly reason: string
}

/** Tab body: connection bar, editor, result grid and pager. */
export function SqlWorkbenchPanel({ sessionId, api }: SqlWorkbenchPanelProps): ReactElement {
  ensureStyles(css)
  const [state, setState] = useState<PanelState>(() =>
    api === undefined ? unavailable(API_MISSING_HINT) : { ...INITIAL_STATE },
  )
  // Documents: one console per tab, each remembering its own SQL and results.
  const [documents, setDocuments] = useState<readonly DocumentTab[]>(() => [createTab([], null)])
  const [activeDocId, setActiveDocId] = useState(() => (documents[0] as DocumentTab).id)
  /** Closed agent consoles, reopenable from the strip (docs/10 §14). */
  const [agentHistory, setAgentHistory] = useState<readonly DocumentTab[]>([])
  const document = activeTab(documents, activeDocId)
  const query = document.query
  const script = document.script
  /**
   * A single-statement console renders through the same tab strip as a script
   * (docs/10 §14 R6): the result area is always a set of tabs. Its sort, filters
   * and total stay in `QueryState` and are passed down, so paging and sorting
   * behave exactly as before.
   */
  const singleTab: ScriptTab = {
    sql: query.sql,
    result: query.result,
    ...(query.error === null ? {} : { error: query.error }),
  }
  const hasSingleResult = query.result !== null || query.error !== null || query.status === 'running'
  /**
   * Data source this console runs on. The tab's own binding wins over the global
   * id: switching tabs only *asks* the host to switch, so for a moment the two
   * disagree, and every read must follow the tab the user is looking at.
   */
  const tabConnId = document.connId ?? state.activeId
  // Every write names its tab. Anything that awaits must capture the id up front:
  // resolving against the *current* active tab would drop a slow result into
  // whichever console the user switched to meanwhile (reported 2026-10-19).
  const writeDoc = useCallback((docId: string, patch: Parameters<typeof patchTab>[2]) => {
    setDocuments(current => patchTab(current, docId, patch))
  }, [])
  /**
   * Surface a rejected background call.
   *
   * Every execution path is fired with `void` from a click handler; without a
   * catch a refused request became an "unhandled rejection" toast that named a
   * JSON parse error instead of the actual problem (2026-10-21).
   */
  const reportFailureToUser = useCallback((error: unknown) => {
    setNotice({ text: error instanceof Error ? error.message : String(error), kind: 'error' })
  }, [])
  const setQueryAt = useCallback((docId: string, next: QueryState | ((current: QueryState) => QueryState)) => {
    writeDoc(docId, tab => ({ query: typeof next === 'function' ? next(tab.query) : next }))
  }, [writeDoc])
  const setScriptAt = useCallback((docId: string, next: ScriptRun | null) => {
    writeDoc(docId, { script: next })
  }, [writeDoc])
  const setQuery = useCallback((next: QueryState | ((current: QueryState) => QueryState)) => {
    setQueryAt(activeDocId, next)
  }, [setQueryAt, activeDocId])
  const setScript = useCallback((next: ScriptRun | null) => {
    setScriptAt(activeDocId, next)
  }, [setScriptAt, activeDocId])
  const [saveError, setSaveError] = useState<SaveError | undefined>(undefined)
  /**
   * Corner notice (bottom-right), for things the user asked for that did not
   * work out — a refused DDL, a full tab strip. Not a modal: the tree stays
   * usable and nothing blocks.
   */
  const [notice, setNotice] = useState<{ readonly text: string; readonly kind: 'error' | 'warn' } | null>(null)

  /**
   * Agent deliveries arrive asynchronously (docs/10 §13.1). The effect reads the
   * active id through a ref so the subscription never re-registers, and applying
   * a delivery never switches the active console (Q14).
   */
  const activeDocIdRef = useRef(activeDocId)
  const documentsRef = useRef(documents)
  useEffect(() => {
    activeDocIdRef.current = activeDocId
  }, [activeDocId])
  useEffect(() => {
    documentsRef.current = documents
  }, [documents])
  useEffect(
    () =>
      subscribeAgentDeliveries(delivery => {
        // The snapshot only phrases the toast; the state change stays a
        // functional update so a concurrent edit is never clobbered.
        const existed = documentsRef.current.some(
          tab => tab.owner === 'agent' && tab.label === delivery.label && tab.connId === delivery.connId,
        )
        const crowded = isAgentPoolFull(documentsRef.current)
        setDocuments(current => applyAgentDelivery(current, activeDocIdRef.current, delivery).tabs)
        setNotice({
          text:
            `${existed ? `ai_${delivery.label} 已更新` : `ai_${delivery.label} 已出结果`}` +
            (crowded ? `（AI 控制台已达 ${String(MAX_AGENT_TABS)} 个，可关闭不用的）` : ''),
          kind: 'warn',
        })
      }),
    [],
  )

  // Overflow consoles move into the history rather than being destroyed (§15 A3).
  // An effect, not a render-phase updater: React may invoke those twice.
  useEffect(() => {
    const overflow = archiveOverflow(documents, activeDocId)
    const archived = overflow.archived
    if (archived === null) return
    setDocuments(overflow.tabs)
    setAgentHistory(previous => pushArchive(previous, archived))
  }, [documents, activeDocId])

  /**
   * Publish console ownership so the agent can refuse writing into a user
   * console (docs/10 §13.3). Debounced: the editor changes `documents` on every
   * keystroke, and only ids/owners/titles matter to the registry.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      void publishConsoles(
        documents.map(tab => ({
          id: tab.id,
          owner: tab.owner === 'agent' ? 'agent' : 'user',
          title: tab.title,
          ...(tab.label === undefined ? {} : { label: tab.label }),
        })),
      )
    }, 300)
    return () => {
      clearTimeout(timer)
    }
  }, [documents])

  // Clipboard failures have no call-site context (grid, dialog, tree all copy),
  // so the one notifier lives here and every copy path reports through it.
  useEffect(() => {
    setCopyFailureHandler(text => {
      setNotice({ text, kind: 'warn' })
    })
    return () => {
      setCopyFailureHandler(undefined)
    }
  }, [])
  const [busy, setBusy] = useState(false)
  const [schema, setSchema] = useState<SchemaSnapshot | undefined>(undefined)
  const [schemaError, setSchemaError] = useState<string | undefined>(undefined)
  const [schemaLoading, setSchemaLoading] = useState(false)
  /** The object browser is the left column now, and it starts open. */
  const [treeOpen, setTreeOpen] = useState(true)
  const [treeWidth, setTreeWidth] = useState(TREE_WIDTH_DEFAULT)
  const [editorHeight, setEditorHeight] = useState(EDITOR_HEIGHT_DEFAULT)
  /** Set once the stored layout has been applied, so a save never races the load. */
  const layoutReady = useRef(false)
  const editorRef = useRef<SqlEditorHandle | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  /** The three panels live in here; the sashes measure it at drag start. */
  const workspaceRef = useRef<HTMLDivElement | null>(null)

  // Completion metadata follows the active connection; a failed read only costs
  // schema suggestions, so it degrades to keywords instead of an error banner.
  // Switching connections invalidates anything that came from the previous one.
  // The first resolution (null → id on load) is not a switch: keep what the user ran.
  const previousConnection = useRef<string | null>(null)
  /** Set while a tab switch is driving the connection, so its results survive. */
  const switchingTab = useRef(false)
  useEffect(() => {
    const previous = previousConnection.current
    previousConnection.current = state.activeId
    if (switchingTab.current) {
      switchingTab.current = false
      return
    }
    if (previous === null || previous === state.activeId) return
    setScript(null)
    setQuery(current => ({ ...current, result: null, error: null, total: null, status: 'idle' }))
  }, [state.activeId])

  useEffect(() => {
    if (api === undefined || tabConnId === null) {
      setSchema(undefined)
      return
    }
    let alive = true
    setSchemaLoading(true)
    api.schema(tabConnId)
      .then(snapshot => {
        if (!alive) return
        setSchema(snapshot)
        setSchemaError(undefined)
      })
      .catch((error: unknown) => {
        if (!alive) return
        setSchema(undefined)
        setSchemaError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (alive) setSchemaLoading(false)
      })
    return () => {
      alive = false
    }
  }, [api, tabConnId])

  /** Re-read the schema on demand (the tree's refresh button). */
  const refreshSchema = (): void => {
    if (api === undefined || tabConnId === null) return
    setSchemaLoading(true)
    api.schema(tabConnId, { refresh: true })
      .then(snapshot => {
        setSchema(snapshot)
        setSchemaError(undefined)
      })
      .catch((error: unknown) => {
        setSchema(undefined)
        setSchemaError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setSchemaLoading(false)
      })
  }

  // A narrow sidebar (it can be ~500px inside dsh) must not keep a 244px rail:
  // re-clamp whenever the workspace exists and the window changes size. The
  // dependency is the phase, not `[]`: the first paint is the loading state, so
  // a mount-only effect would measure a workspace that is not in the DOM yet.
  React.useEffect(() => {
    const measure = (): void => {
      const width = workspaceRef.current?.clientWidth ?? 0
      if (width <= 0) return
      setTreeWidth(current => clampSize(current, TREE_WIDTH_MIN, maxTreeWidth(width)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
    }
  }, [state.phase])

  /** Workspace measurements; 0 in jsdom, where the helpers fall back. */
  const workspaceSize = (): { width: number; height: number } => ({
    width: workspaceRef.current?.clientWidth ?? 0,
    height: workspaceRef.current?.clientHeight ?? 0,
  })

  const treeBounds = (): { min: number; max: number } => ({
    min: TREE_WIDTH_MIN,
    max: maxTreeWidth(workspaceSize().width),
  })

  const editorBounds = (): { min: number; max: number } => ({
    min: EDITOR_HEIGHT_MIN,
    max: maxEditorHeight(workspaceSize().height),
  })

  /**
   * Restore the saved layout once (docs/09 B3).
   *
   * Clamping happens here, not on the host: only the browser knows the current
   * panel width, and a layout saved in a wider window must not squeeze this one.
   */
  useEffect(() => {
    const read = api?.layout
    if (read === undefined) {
      layoutReady.current = true
      return
    }
    let cancelled = false
    void read
      .call(api)
      .then(stored => {
        if (cancelled) return
        const size = workspaceSize()
        const restored = parseLayout(stored, {
          maxTreeWidth: maxTreeWidth(size.width),
          maxEditorHeight: maxEditorHeight(size.height),
        })
        setTreeOpen(restored.treeOpen)
        setTreeWidth(restored.treeWidth)
        setEditorHeight(restored.editorHeight)
        layoutReady.current = true
      })
      .catch(() => {
        if (!cancelled) layoutReady.current = true
      })
    return () => {
      cancelled = true
    }
  }, [api])

  // Persist after the restore, debounced: a drag fires on every pointer move.
  useEffect(() => {
    const save = api?.saveLayout
    if (save === undefined || !layoutReady.current) return
    const timer = setTimeout(() => {
      void save.call(api, { treeOpen, treeWidth, editorHeight })
    }, 400)
    return () => {
      clearTimeout(timer)
    }
  }, [api, treeOpen, treeWidth, editorHeight])

  /** Run a multi-statement script and keep one tab per statement. */
  const runScript = async (sql: string): Promise<void> => {
    const connId = tabConnId
    if (api === undefined || connId === null) return
    // One script at a time: a second click must not interleave its results.
    if (script?.running === true) return
    const docId = activeDocId
    const statements = splitStatements(sql)
    setScriptAt(docId, {
      tabs: statements.map(statement => ({ sql: statement.text, result: null, pageSize: query.pageSize })),
      active: 0,
      running: true,
    })
    try {
      const outcome = await api.executeScript({ connId, sql, pageSize: query.pageSize })
      if ('refusal' in outcome) {
        const refusal = outcome.refusal as { readonly code: string; readonly message: string }
        setScriptAt(docId, {
          tabs: [{ sql, result: null, error: refusal }],
          active: 0,
          running: false,
        })
        return
      }
      const tabs: ScriptTab[] = outcome.statements.map(statement =>
        statement.ok
          ? {
              sql: statement.sql,
              result: statement.response,
              pageSize: query.pageSize,
              total: statement.response.total,
            }
          : { sql: statement.sql, result: null, error: statement.error, pageSize: query.pageSize },
      )
      setScriptAt(docId, { tabs, active: Math.max(0, tabs.length - 1), running: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setScriptAt(docId, {
        tabs: [{ sql, result: null, error: { code: 'SCRIPT_FAILED', message } }],
        active: 0,
        running: false,
      })
    }
  }

  /** Re-run one statement of the script for its next page / sort. */
  /** Replace one statement tab, leaving the rest of the run untouched. */
  const replaceScriptTab = (tabs: readonly ScriptTab[], index: number, next: ScriptTab): ScriptTab[] => {
    const copy = [...tabs]
    copy[index] = next
    return copy
  }

  /**
   * Refetch one statement tab (docs/10 §14 R6).
   *
   * The intent — ordering, filters, page size — is written onto **that tab**
   * before the request and kept afterwards, so two tabs can hold different
   * orderings and switching between them loses neither.
   */
  const refetchScript = async (
    index: number,
    patch: {
      readonly offset?: number
      readonly sort?: SortSpec | null
      readonly filters?: readonly FilterSpec[]
      readonly pageSize?: number
    },
  ): Promise<void> => {
    const connId = tabConnId
    if (api === undefined || connId === null || script === null) return
    const current = script.tabs[index]
    if (current === undefined) return
    const docId = activeDocId
    const intent: ScriptTab = {
      ...current,
      sort: patch.sort === undefined ? current.sort ?? null : patch.sort,
      filters: patch.filters === undefined ? current.filters ?? [] : patch.filters,
      ...(patch.pageSize === undefined && current.pageSize === undefined
        ? {}
        : { pageSize: patch.pageSize ?? current.pageSize }),
    }
    setScriptAt(docId, { ...script, tabs: replaceScriptTab(script.tabs, index, intent), running: true })
    try {
      const result = await api.fetchPage({
        connId,
        sql: intent.sql,
        pageSize: intent.pageSize ?? query.pageSize,
        ...(patch.offset === undefined ? {} : { offset: patch.offset }),
        ...(intent.sort === null || intent.sort === undefined ? {} : { sort: intent.sort }),
        ...(intent.filters === undefined || intent.filters.length === 0 ? {} : { filters: intent.filters }),
      })
      const nextTab: ScriptTab = {
        sql: intent.sql,
        result: result.ok ? result : intent.result,
        sort: intent.sort ?? null,
        filters: intent.filters ?? [],
        total: result.ok ? result.total : intent.total ?? null,
        ...(intent.pageSize === undefined ? {} : { pageSize: intent.pageSize }),
        ...(result.ok ? {} : { error: result.error }),
      }
      setScriptAt(docId, { ...script, tabs: replaceScriptTab(script.tabs, index, nextTab), running: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setScriptAt(docId, {
        ...script,
        tabs: replaceScriptTab(script.tabs, index, { ...intent, error: { code: 'PAGE_FAILED', message } }),
        running: false,
      })
    }
  }

  const sortScript = (index: number, column: string): Promise<void> => {
    const tab = script?.tabs[index]
    return refetchScript(index, { offset: 0, sort: nextSort(tab?.sort ?? null, column) })
  }

  const pageScript = (index: number, offset: number): Promise<void> => refetchScript(index, { offset })

  /** Remember the page size on the tab; the next page fetch uses it. */
  const pageSizeScript = (index: number, size: number): void => {
    if (script === null) return
    const tab = script.tabs[index]
    if (tab === undefined) return
    setScriptAt(activeDocId, {
      ...script,
      tabs: replaceScriptTab(script.tabs, index, { ...tab, pageSize: size }),
    })
  }

  const filterScript = (index: number, column: string, filter: FilterSpec | null): Promise<void> => {
    const tab = script?.tabs[index]
    if (tab === undefined) return Promise.resolve()
    const next = [
      ...(tab.filters ?? []).filter(entry => entry.column !== column),
      ...(filter === null ? [] : [filter]),
    ]
    return refetchScript(index, { offset: 0, filters: next })
  }

  const clearFiltersScript = (index: number): Promise<void> => refetchScript(index, { offset: 0, filters: [] })

  /** Tab titles show connection names; the bar already has the list. */
  const connectionNames = Object.fromEntries(state.connections.map(source => [source.id, source.name]))
  const markRun = (sql: string): void => {
    setDocuments(current => patchTab(current, activeDocId, { lastRunSql: sql }))
  }

  /**
   * Make the host follow a console's data source.
   *
   * Switching tabs is not a connection change the user asked for, so the flag
   * tells the reset effect to keep the results that belong to that console.
   */
  const followTab = (target: DocumentTab): void => {
    if (api === undefined || target.connId === null || target.connId === state.activeId) return
    switchingTab.current = true
    void api
      .setActive(target.connId)
      .then(() => load(api))
      .then(setState)
      .catch(reportFailureToUser)
  }

  /** Switch console: the tab owns its connection, so the bar follows it. */
  const selectDocument = (id: string): void => {
    const target = activeTab(documents, id)
    setActiveDocId(id)
    // Opening an agent console clears its unread dot (Q14).
    if (target.unread === true) setDocuments(current => markAgentRead(current, id))
    followTab(target)
  }

  const addDocument = (): void => {
    if (documents.length >= MAX_TABS) return
    const created = createTab(documents, tabConnId)
    setDocuments(current => [...current, created])
    setActiveDocId(created.id)
  }

  const removeDocument = (id: string): void => {
    const outcome = closeTab(documents, id)
    setDocuments(outcome.tabs)
    if (id !== activeDocId) return
    setActiveDocId(outcome.activeId)
    // Closing the console we were in lands on a neighbour that may live on
    // another data source; leaving the bar behind would mislabel the next run.
    followTab(activeTab(outcome.tabs, outcome.activeId))
  }

  /**
   * Reopen a console from the AI history.
   *
   * Unlike a delivery, this focus change is the user's own click, so selecting
   * the console (and following its connection) is right here.
   */
  const restoreAgentDocument = (id: string): void => {
    const { archive, tab } = takeArchived(agentHistory, id)
    if (tab === null) return
    setAgentHistory(archive)
    setDocuments(current =>
      current.some(entry => entry.id === tab.id) ? current : [...current, { ...tab, unread: false }],
    )
    setActiveDocId(tab.id)
    followTab(tab)
  }

  // The first tab binds to whichever connection became active after load.
  React.useEffect(() => {
    if (state.activeId === null || document.connId !== null) return
    setDocuments(current => patchTab(current, activeDocId, { connId: state.activeId }))
  }, [state.activeId, activeDocId, document.connId])

  const schemaIndex: SchemaIndex | undefined = schema === undefined ? undefined : { tables: schema.tables }
  /** Strip the wire code the route adds: the pane shows the sentence, not "INTERNAL:". */
  const readable = (text: string): string => text.replace(/^[A-Z][A-Z_]+:\s*/, '')
  const schemaNote = schema?.note ?? (schemaError === undefined ? undefined : readable(schemaError))

  useEffect(() => {
    if (api === undefined) {
      setState(unavailable(API_MISSING_HINT))
      return
    }
    void load(api).then(setState).catch(reportFailureToUser)
  }, [api])

  const run = useCallback(async (work: () => Promise<PanelState>) => {
    setBusy(true)
    try {
      setState(await work())
    } finally {
      setBusy(false)
    }
  }, [])

  // Query actions all need the active connection, which lives in panel state;
  // the state machine reports the in-flight state so the grid and cancel react
  // immediately, before the host answers.
  const withConnection = useCallback(
    async (work: (connId: string, publish: (running: QueryState) => void) => Promise<QueryState>) => {
      // The tab owns its data source (DataGrip consoles do too): reading the
      // global active id would run console_2 against whatever was selected last,
      // and the colour dot would lie (reported 2026-10-19).
      const connId = tabConnId
      if (connId === null) return
      // Pin both the "running" update and the final result to the tab that started
      // the run. Reading the active tab later would drop a slow result into whichever
      // console the user switched to meanwhile (reported 2026-10-19).
      const docId = activeDocId
      const write = (next: QueryState): void => {
        setQueryAt(docId, next)
      }
      try {
        write(await work(connId, write))
      /* v8 ignore start -- query state helpers convert transport failures into QueryState errors */
      } catch (error) {
        // One catch covers every execution button: they all come through here.
        reportFailureToUser(error)
      }
      /* v8 ignore stop */
    },
    [tabConnId, activeDocId, setQueryAt, reportFailureToUser],
  )

  if (api === undefined || state.phase === 'unavailable') {
    return (
      <section className={styles.sqlWorkbenchPanel} data-sql-workbench="" data-session-id={sessionId} data-phase="unavailable">
        <div className={styles.placeholder}>
          <span className={styles.sqlWorkbenchTitle}>SQL 工作台</span>
          <span className={styles.sqlWorkbenchHint}>{state.message}</span>
        </div>
      </section>
    )
  }

  if (state.phase === 'loading') {
    return (
      <section className={styles.sqlWorkbenchPanel} data-sql-workbench="" data-session-id={sessionId} data-phase="loading">
        <div className={styles.placeholder}>
          <span className={styles.sqlWorkbenchHint}>正在读取连接…</span>
        </div>
      </section>
    )
  }

  const editing = state.editing
  const hasConnections = state.connections.length > 0
  const connectionName = state.connections.find(source => source.id === tabConnId)?.name

  /**
   * DataGrip's `Edit Data` (F4) with a console standing in for its data editor:
   * fill the editor with the statement, then run it in this console.
   */
  const openData = (sql: string): void => {
    const next = setSql(query, sql)
    setQuery(next)
    void withConnection((connId, publish) => executeQuery(api, next, connId, publish))
  }

  /** `Go to DDL` (Ctrl+B): a raw statement — metadata reads cannot be paged. */
  /** `SHOW CREATE …` text for a target, in words the dialog/corner can show. */
  const loadDdlText = async (target: DdlTarget): Promise<string> => {
    /* v8 ignore next -- the browser only renders once a data source exists */
    if (tabConnId === null) throw new Error('当前标签还没有绑定连接')
    try {
      const outcome = await api.execute({ connId: tabConnId, sql: ddlSql(target), pageSize: 1, raw: true })
      // The driver's refusal is accurate but unreadable as-is; keep the facts,
      // add the action (docs/03 §6.7 错误文案).
      if (!outcome.ok) throw new Error(readableDbError(outcome.error))
      const text = ddlFromRow(outcome.rows[0])
      if (text === '') throw new Error('数据库没有返回 DDL（检查该对象的权限）')
      return text
    } catch (error) {
      // A refused statement comes back as an HTTP error, which the transport
      // throws rather than returning as `ok:false` — translate here too, or the
      // dialog shows `INTERNAL: errCode = 2, detailMessage = …` verbatim.
      throw new Error(readableDbError({ message: error instanceof Error ? error.message : String(error) }))
    }
  }

  /**
   * DataGrip's *Go to DDL* opens the statement in a console; so do we.
   *
   * A refusal is a corner notice, not a modal over the tree: the user asked for
   * the DDL, and "you may not see it" is information, not an interruption.
   */
  const openDdlConsole = (target: DdlTarget): void => {
    void (async () => {
      try {
        const text = await loadDdlText(target)
        if (documents.length >= MAX_TABS) {
          setNotice({ text: `标签已满（最多 ${String(MAX_TABS)} 个），先关一个再查看 DDL`, kind: 'warn' })
          return
        }
        const created = createTab(documents, tabConnId)
        const withDdl: DocumentTab = {
          ...created,
          title: `ddl_${target.table}`,
          query: setSql(INITIAL_QUERY, text),
          // Mark it as "already what it is": a DDL tab is not unsaved work, so
          // it must not carry the `*` (dirty) marker.
          lastRunSql: text,
        }
        setDocuments(current => [...current, withDdl])
        setActiveDocId(withDdl.id)
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), kind: 'error' })
      }
    })()
  }

  return (
    <section className={styles.sqlWorkbenchPanel} data-sql-workbench="" data-session-id={sessionId} data-phase={state.phase} ref={panelRef}>
      <ConnectionBar
        connections={state.connections}
        activeId={state.activeId}
        testingId={state.testingId}
        verdicts={state.verdicts}
        onSelect={connId => {
          // The console follows the toolbar, the way DataGrip's data-source
          // selector rebinds the console it sits in.
          setDocuments(current => patchTab(current, activeDocId, { connId }))
          void run(() => select(api, state, connId))
        }}
        onTest={connId => {
          void run(() => test(api, state, connId))
        }}
        onCreate={() => {
          setSaveError(undefined)
          setState({ ...state, editing: draftFor('doris') })
        }}
        onEdit={connId => {
          setSaveError(undefined)
          setState(startEdit(state, connId))
        }}
      />

      {hasConnections ? (
        <>
          {/* Three panels, two sashes: objects on the left, editor over results
              on the right. Separation comes from the 8px gap, not a border. */}
          <div
            className={styles.workspace}
            ref={workspaceRef}
            data-sql-workspace=""
            data-tree={treeOpen ? 'open' : 'closed'}
            style={{
              /* Collapsing drops the column and the sash, so the editor gets the
                 whole width. The old fallback had no template at all, and the grid
                 stacked its two children into rows — the page looked squeezed. */
              gridTemplateColumns: treeOpen
                ? `${String(treeWidth)}px ${String(PANEL_GAP)}px minmax(0, 1fr)`
                : 'minmax(0, 1fr)',
              gridTemplateRows: 'minmax(0, 1fr)',
            }}
          >
            {treeOpen ? (
              <>
                <WorkbenchPanel
                  id="objects"
                  title="对象"
                  meta={schemaLoading
                    ? '读取中…'
                    : schema === undefined
                      ? (schemaError === undefined ? '未加载' : readable(schemaError))
                      : `${describeSchema(schema.tables)} · ${schema.source === 'show' ? 'SHOW' : 'information_schema'}`}
                  actions={(
                    <button
                      type="button"
                      className={styles.panelIconButton}
                      aria-label="刷新表结构"
                      title="刷新表结构"
                      disabled={schemaLoading}
                      onClick={refreshSchema}
                    >
                      ↻
                    </button>
                  )}
                >
                  <div className={styles.treeFill}>
                    <SchemaTree
                      tables={schema?.tables ?? []}
                      {...(schemaNote === undefined ? {} : { note: schemaNote })}
                      loading={schemaLoading}
                      showRefresh={false}
                      {...(connectionName === undefined ? {} : { connectionName })}
                      onRefresh={refreshSchema}
                      onInsert={name => {
                        editorRef.current?.insert(name)
                      }}
                      onOpenData={openData}
                      onShowDdl={openDdlConsole}
                      onCopy={copyText}
                    />
                  </div>
                </WorkbenchPanel>
                <Sash
                  orientation="vertical"
                  label="调整对象树宽度"
                  value={treeWidth}
                  bounds={treeBounds}
                  onChange={next => {
                    setTreeWidth(clampSize(next, TREE_WIDTH_MIN, maxTreeWidth(workspaceSize().width)))
                  }}
                  onReset={() => {
                    setTreeWidth(TREE_WIDTH_DEFAULT)
                  }}
                />
              </>
            ) : null}

            <div
              className={styles.paneColumn}
              data-sql-pane-column=""
              style={{ gridTemplateRows: `${String(editorHeight)}px ${String(PANEL_GAP)}px minmax(${String(RESULT_HEIGHT_MIN)}px, 1fr)` }}
            >
              <WorkbenchPanel id="editor" headless>
                {/* The console strip belongs to the editor pane, the way
                    DataGrip's `console_17 …` tab sits on the editor itself. */}
                <DocumentTabs
                  tabs={documents}
                  activeId={activeDocId}
                  connectionNames={connectionNames}
                  archived={agentHistory}
                  objectsOpen={treeOpen}
                  onToggleObjects={() => {
                    // Re-clamp on the way out: the sidebar may have shrunk since
                    // the width was remembered, and an over-wide tree would take
                    // the editor to zero.
                    setTreeWidth(current => clampSize(current, TREE_WIDTH_MIN, maxTreeWidth(workspaceSize().width)))
                    setTreeOpen(open => !open)
                  }}
                  onRestore={restoreAgentDocument}
                  onSelect={selectDocument}
                  onClose={removeDocument}
                  onCreate={addDocument}
                  canCreate={documents.length < MAX_TABS}
                />
                <div className={styles.editorBlock}>
                  <SqlEditor
                    ref={editorRef}
                    sql={query.sql}
                    running={query.status === 'running' || (script?.running ?? false)}
                    disabled={tabConnId === null}
                    {...(schemaIndex === undefined ? {} : { schema: schemaIndex })}
                    onChange={sql => {
                      setQuery(setSql(query, sql))
                    }}
                    onRun={() => {
                      /* v8 ignore next -- the editor is mounted whenever the button is enabled */
                      const selection = editorRef.current?.getSelection() ?? ''
                      const source = selection.trim() === '' ? query.sql : selection
                      markRun(source)
                      if (splitStatements(source).length <= 1) {
                        setScript(null)
                        void withConnection((connId, publish) => executeQuery(api, query, connId, publish))
                        return
                      }
                      void runScript(source)
                    }}
                    onCancel={() => {
                      void cancelQuery(api, query).then(setQuery).catch(reportFailureToUser)
                    }}
                  />
                </div>
              </WorkbenchPanel>

              <Sash
                orientation="horizontal"
                label="调整编辑器高度"
                value={editorHeight}
                bounds={editorBounds}
                onChange={next => {
                  setEditorHeight(clampSize(next, EDITOR_HEIGHT_MIN, maxEditorHeight(workspaceSize().height)))
                }}
                onReset={() => {
                  setEditorHeight(EDITOR_HEIGHT_DEFAULT)
                }}
              />

              <WorkbenchPanel id="result" title="结果">
                {script === null ? (
                  hasSingleResult ? (
                    <ScriptResults
                      tabs={[
                        {
                          ...singleTab,
                          sort: query.sort,
                          filters: query.filters,
                          pageSize: query.pageSize,
                          total: query.total,
                        },
                      ]}
                      active={0}
                      running={query.status === 'running'}
                      pageSize={query.pageSize}
                      onActive={
                        /* v8 ignore next -- a single-result strip has no alternate tab to activate */
                        () => undefined
                      }
                      onSort={(_index, column) => {
                        void withConnection((connId, publish) => sortBy(api, query, connId, column, publish))
                      }}
                      onPage={(_index, offset) => {
                        void withConnection((connId, publish) => goPage(api, query, connId, offset, publish))
                      }}
                      onPageSize={(_index, size) => {
                        setQuery(setPageSize(query, size))
                      }}
                      onRefresh={() => {
                        void withConnection((connId, publish) => executeQuery(api, query, connId, publish))
                      }}
                      onFilter={(_index, column, filter) => {
                        // Server-side: one condition per column, ANDed; re-run so
                        // the total and the rows agree with the condition.
                        const next = [
                          ...query.filters.filter(entry => entry.column !== column),
                          ...(filter === null ? [] : [filter]),
                        ]
                        const withFilters = setFilters(query, next)
                        setQuery(withFilters)
                        void withConnection((connId, publish) => executeQuery(api, withFilters, connId, publish))
                      }}
                      onClearFilters={() => {
                        const cleared = setFilters(query, [])
                        setQuery(cleared)
                        void withConnection((connId, publish) => executeQuery(api, cleared, connId, publish))
                      }}
                    />
                  ) : (
                    <ResultGrid
                      result={null}
                      sort={query.sort}
                      error={null}
                      running={false}
                      onSort={
                        /* v8 ignore next -- an empty grid has no column header that can invoke sorting */
                        () => undefined
                      }
                      filterEnabled={false}
                    />
                  )
                ) : (
                  <ScriptResults
                    tabs={script.tabs}
                    active={script.active}
                    running={script.running}
                    pageSize={query.pageSize}
                    onActive={index => {
                      setScript({ ...script, active: index })
                    }}
                    onSort={(index, column) => {
                      void sortScript(index, column)
                    }}
                    onPage={(index, offset) => {
                      void pageScript(index, offset)
                    }}
                    onRefresh={index => {
                      /* v8 ignore next -- refresh only renders for an existing successful result tab */
                      void refetchScript(index, { offset: script.tabs[index]?.result?.offset ?? 0 })
                    }}
                    onPageSize={(index, size) => {
                      pageSizeScript(index, size)
                    }}
                    onFilter={(index, column, filter) => {
                      void filterScript(index, column, filter)
                    }}
                    onClearFilters={index => {
                      void clearFiltersScript(index)
                    }}
                  />
                )}
              </WorkbenchPanel>
            </div>
          </div>
        </>
      ) : (
        <div className={styles.placeholder}>
          <span className={styles.sqlWorkbenchTitle}>还没有数据源</span>
          <span className={styles.sqlWorkbenchHint}>点「新建」配置一个 Doris 连接，保存后即可测试连通性并执行查询。</span>
          {state.phase === 'error' ? <span className={styles.sqlWorkbenchHint}>{state.message}</span> : null}
        </div>
      )}

      {notice === null ? null : (
        <div
          className={styles.notice}
          data-sql-notice={notice.kind}
          role="status"
          aria-live="polite"
        >
          <span className={styles.noticeText}>{notice.text}</span>
          <button
            type="button"
            className={styles.noticeClose}
            aria-label="关闭提示"
            onClick={() => {
              setNotice(null)
            }}
          >
            ×
          </button>
        </div>
      )}

      {editing === null ? null : (
        <ConnectionDialog
          title={editing.id === undefined ? '新建连接' : '连接配置'}
          draft={editing}
          error={saveError}
          busy={busy}
          onChange={(draft: ConnectionDraft) => {
            setState({ ...state, editing: draft })
          }}
          onSubmit={() => {
            void (async () => {
              setSaveError(undefined)
              const outcome = await save(api, state, editing)
              if (outcome.ok) setState(outcome.state)
              else setSaveError({ field: outcome.field, reason: outcome.reason })
            })()
          }}
          onCancel={() => {
            setSaveError(undefined)
            setState(cancelEdit(state))
          }}
          onDelete={
            editing.id === undefined
              ? undefined
              : () => {
                  const connId = editing.id
                  void run(() => removeConnection(api, state, connId as string))
                }
          }
        />
      )}
    </section>
  )
}

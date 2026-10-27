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
  nextStatementId,
  run as executeQuery,
  nextSort,
  setFilters,
  setMode,
  setPageSize,
  setSql,
  sortBy,
} from '../state/query.ts'
import type { ExecuteResponse, FilterSpec, SortSpec } from '../../execute/core.ts'
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
import { ConnectionBar } from './ConnectionBar.tsx'
import { OverflowMenu } from './OverflowMenu.tsx'
import { WorkbenchPanel, Sash } from './WorkbenchPanel.tsx'
import { ConnectionDialog } from './ConnectionDialog.tsx'
import { copyText, setCopyFailureHandler } from '../clipboard.ts'
import { readableDbError } from '../db-error.ts'
import { type DdlTarget, ddlFromRow, ddlSql, describeSchema, joinSql } from '../schema-tree.ts'
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
import type { SchemaIndex, SchemaTable } from '../completion.ts'
import type { RunTarget } from '../editor-cm.ts'
import type { SchemaSnapshot } from '../../host/metadata.ts'
import { DocumentTabs } from './DocumentTabs.tsx'
import { SchemaTree } from './SchemaTree.tsx'
import { ScriptResults } from './ScriptResults.tsx'
import type { ScriptTab } from './ScriptResults.tsx'
import { splitStatements, statementAt } from '../../execute/split.ts'
import { parseLayout } from '../state/layout.ts'
import { expandStar } from '../expand-star.ts'
import { formatSql } from '../sql-format.ts'
import {
  EMPTY_HISTORY,
  type FavoriteEntry,
  type HistoryDocument,
  type QueryHistoryEntry,
  addFavorite,
  favoriteFromHistory,
  fitWorkspace,
  insertHistory,
  parseFavoritesDocument,
  parseHistoryDocument,
  parseWorkspaceState,
  removeFavorite,
  restoreConsoleDocuments,
  toFavoritesDocument,
  toWorkspaceState,
} from '../state/history.ts'
import { HistoryPanel } from './HistoryPanel.tsx'
import { CommandPalette } from './CommandPalette.tsx'
import { ObjectSearch } from './ObjectSearch.tsx'
import { ShortcutsHelp } from './ShortcutsHelp.tsx'
import { ParamsForm } from './ParamsForm.tsx'
import { ShortcutSettings } from './ShortcutSettings.tsx'
import {
  type ShortcutSettings as ShortcutSettingsMap,
  comboFromEvent,
  displayCombo,
  loadSettings,
  normalizeCombo,
  saveSettings,
} from '../shortcut-settings.ts'
import { TableOverview } from './TableOverview.tsx'
import { findSqlParams, paramNames, substituteSqlParams } from '../params.ts'
import { parseTableTitle } from '../result-tabs.ts'
import { type KeywordCase } from '../sql-format.ts'
import { explainSqlPrompt, optimizeSqlPrompt } from '../agent-prompts.ts'
import { sendToChat } from '../chat-bridge.ts'
import { DiffProposal } from './DiffProposal.tsx'
import type { CommandAction } from '../commands.ts'
import { subscribeAgentDeliveries, publishConsoles } from '../agent-stream.ts'
import type { SqlEditorHandle } from './SqlEditor.tsx'
import { ResultGrid } from './ResultGrid.tsx'
import { SqlEditor } from './SqlEditor.tsx'
import { classes as styles, ensureStyles } from '../styles.ts'
import css from './sqlWorkbench.css'

/** Same prefix the execution gate refuses unless the connection is writable. */
const WRITE_STATEMENT = /^\s*(insert|update|delete|replace|merge|truncate|create|alter|drop|rename|grant|revoke|call|do|load|set)\b/i

/** What a click will run: the selection when it has text, otherwise the caret statement. */
function aimedText(sql: string, cursor: number, from: number, to: number): string {
  if (from !== to) {
    const selected = sql.slice(from, to)
    if (selected.trim() !== '') return selected
  }
  return statementAt(sql, cursor)?.text ?? sql
}

/** Label for the single run control: 执行, or 执行写入 when the aimed text is a write. */
function runControlLabel(sql: string, cursor: number, from: number, to: number): string {
  return WRITE_STATEMENT.test(aimedText(sql, cursor, from, to)) ? '执行写入' : '执行'
}

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
    mode: query.mode,
    ...(parseTableTitle(query.sql) === null ? {} : { title: parseTableTitle(query.sql) as string }),
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
  /** Query history / favorites drawer (SQL-204/205). */
  const [historyOpen, setHistoryOpen] = useState(false)
  /** Command palette / global object search / shortcut sheet (SQL-213/214). */
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [objectSearchOpen, setObjectSearchOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  /** Inline diagnostics switch (SQL-309), on by default. */
  const [lintEnabled, setLintEnabled] = useState(true)
  /** 执行 vs 执行写入, updated from the editor so it follows the caret and the selection. */
  const [aimLabel, setAimLabel] = useState('执行')
  /** Formatting keyword case (SQL-209), cycled from the palette. */
  const [keywordCase, setKeywordCase] = useState<KeywordCase>('upper')
  /** Left table of a pending JOIN pick (SQL-212). */
  const [joinFrom, setJoinFrom] = useState<SchemaTable | null>(null)
  /** A statement waiting for its `:name` parameters (SQL-403). */
  const [pendingParams, setPendingParams] = useState<{
    readonly names: readonly string[]
    readonly sql: string
    readonly mode: 'run' | 'script' | 'explain'
  } | null>(null)
  /** Agent diff proposal awaiting accept/reject (SQL-406). */
  const [diffProposal, setDiffProposal] = useState<{ readonly original: string; readonly proposal: string } | null>(null)
  /** Editable key bindings + the settings sheet (requirement 1). */
  const [shortcuts, setShortcuts] = useState<ShortcutSettingsMap>(() => loadSettings())
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  /** Table preview dialog (requirement 5). */
  const [overviewTable, setOverviewTable] = useState<SchemaTable | null>(null)
  const [historyDoc, setHistoryDoc] = useState<HistoryDocument>(EMPTY_HISTORY)
  const [favorites, setFavorites] = useState<readonly FavoriteEntry[]>([])
  /** Cursor offset per console id, persisted with the workspace snapshot. */
  const cursorByDocRef = useRef<Record<string, number>>({})
  /** Saves are ignored until the stored snapshot has been read (or found absent). */
  const restoreDoneRef = useRef(false)

  /**
   * Agent deliveries arrive asynchronously (docs/10 §13.1). The effect reads the
   * active id through a ref so the subscription never re-registers, and applying
   * a delivery never switches the active console (Q14).
   */
  const activeDocIdRef = useRef(activeDocId)
  /**
   * Monotonic run token.
   *
   * Every new execution bumps it; a response may only write state while its
   * token is still current. That is what stops a cancelled (or superseded)
   * request from overwriting the newest result or the "查询已取消" message.
   */
  const runSeq = useRef(0)
  /** Last executed SQL text, for `Ctrl+Alt+Enter` (repeat) and filter reset. */
  const lastRunRef = useRef<string | null>(null)
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
  /** Statement ids of the running script, for the cancel button (SQL-107). */
  const scriptIdsRef = useRef<readonly string[]>([])
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

  /** Ask for `:name` values before running; false means "no parameters". */
  const requestParams = (sql: string, mode: 'run' | 'script' | 'explain'): boolean => {
    const params = findSqlParams(sql)
    if (params.length === 0) return false
    setPendingParams({ names: paramNames(params), sql, mode })
    return true
  }

  /** Substitute the entered values and continue the interrupted action. */
  const submitParams = (values: Readonly<Record<string, string>>): void => {
    const pending = pendingParams
    setPendingParams(null)
    /* v8 ignore next -- the dialog only renders while a request is pending */
    if (pending === null) return
    const sql = substituteSqlParams(pending.sql, values)
    if (pending.mode === 'run') runSource(sql)
    else if (pending.mode === 'script') void runScript(sql)
    else explainStatement(sql)
  }

  /** Run a multi-statement script and keep one tab per statement. */
  const runScript = async (sql: string): Promise<void> => {
    const connId = tabConnId
    if (api === undefined || connId === null) return
    if (requestParams(sql, 'script')) return
    // One script at a time: a second click must not interleave its results.
    if (script?.running === true) return
    const docId = activeDocId
    const seq = (runSeq.current += 1)
    const statements = splitStatements(sql)
    // Client-owned ids so 取消 can stop the statement the script is on (SQL-107).
    const statementIds = statements.map(() => nextStatementId())
    scriptIdsRef.current = statementIds
    // Pinned tabs from the previous run stay put; this run's tabs follow them.
    const pinnedTabs = (script?.tabs ?? []).filter(tab => tab.pinned === true)
    setScriptAt(docId, {
      tabs: [...pinnedTabs, ...statements.map(statement => {
        const title = parseTableTitle(statement.text)
        return {
          sql: statement.text,
          result: null,
          pageSize: query.pageSize,
          ...(title === null ? {} : { title }),
        }
      })],
      active: pinnedTabs.length,
      running: true,
    })
    try {
      const outcome = await api.executeScript({ connId, sql, pageSize: query.pageSize, statementIds })
      // A newer run or a cancel superseded this script; drop the late answer.
      if (seq !== runSeq.current) return
      if ('refusal' in outcome) {
        const refusal = outcome.refusal as { readonly code: string; readonly message: string }
        recordHistory(sql, { ok: false, durationMs: 0, rowCount: null, errorCode: refusal.code })
        setScriptAt(docId, {
          tabs: [...pinnedTabs, { sql, result: null, error: refusal }],
          active: pinnedTabs.length,
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
      const failed = outcome.statements.find(statement => !statement.ok)
      recordHistory(sql, {
        ok: failed === undefined,
        durationMs: outcome.durationMs,
        rowCount: outcome.statements.reduce((sum, statement) => sum + (statement.ok ? statement.response.rows.length : 0), 0),
        ...(failed !== undefined && !failed.ok ? { errorCode: failed.error.code } : {}),
      })
      setScriptAt(docId, { tabs: [...pinnedTabs, ...tabs], active: pinnedTabs.length + Math.max(0, tabs.length - 1), running: false })
    } catch (error) {
      if (seq !== runSeq.current) return
      const message = error instanceof Error ? error.message : String(error)
      recordHistory(sql, { ok: false, durationMs: 0, rowCount: null, errorCode: 'SCRIPT_FAILED' })
      setScriptAt(docId, {
        tabs: [...pinnedTabs, { sql, result: null, error: { code: 'SCRIPT_FAILED', message } }],
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
    // Remember where the outgoing console's caret was before the editor swaps
    // documents (SQL-202).
    const cursor = editorRef.current?.getCursor()
    if (cursor !== undefined && activeDocId !== '') {
      cursorByDocRef.current = { ...cursorByDocRef.current, [activeDocId]: cursor }
    }
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

  /**
   * Restore the persisted workspace, history and favorites (SQL-201/202/204).
   *
   * Only the SQL and its context are stored — never result sets — and a failed
   * read leaves the freshly created console in place instead of blanking the
   * panel.
   */
  useEffect(() => {
    if (api === undefined) return
    let cancelled = false
    void (async () => {
      try {
        const restored = restoreConsoleDocuments(parseWorkspaceState(await api.loadWorkspaceState?.()))
        if (!cancelled && restored !== null) {
          setDocuments(restored.tabs)
          setActiveDocId(restored.activeId)
          cursorByDocRef.current = { ...restored.cursors }
        }
        const history = parseHistoryDocument(await api.loadHistory?.())
        if (!cancelled) setHistoryDoc(history)
        const pinned = parseFavoritesDocument(await api.loadFavorites?.())
        if (!cancelled) setFavorites(pinned.entries)
      } catch (error) {
        reportFailureToUser(error)
      } finally {
        if (!cancelled) restoreDoneRef.current = true
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, reportFailureToUser])

  /**
   * Save the workspace on the same rhythm as the layout: debounced, best-effort
   * and only after the restore attempt so an empty default never overwrites a
   * stored snapshot.
   */
  useEffect(() => {
    const save = api?.saveWorkspaceState
    if (save === undefined || !restoreDoneRef.current) return
    const timer = setTimeout(() => {
      const activeCursor = editorRef.current?.getCursor()
      if (activeCursor !== undefined && activeDocId !== '') {
        cursorByDocRef.current = { ...cursorByDocRef.current, [activeDocId]: activeCursor }
      }
      const state = fitWorkspace(toWorkspaceState(documents, activeDocId, cursorByDocRef.current))
      void save(state).catch(() => undefined)
    }, 500)
    return () => {
      clearTimeout(timer)
    }
  }, [api, documents, activeDocId])

  // A restored console keeps its caret when the user switches back to it.
  useEffect(() => {
    const offset = cursorByDocRef.current[activeDocId]
    if (offset === undefined) return
    editorRef.current?.setCursor(offset)
  }, [activeDocId])

  /**
   * Workbench-wide keyboard entries (SQL-213/214).
   *
   * Ctrl/Cmd+Shift+P opens the command palette and Ctrl/Cmd+Shift+O the object
   * search. Both are also reachable from inside the palette; plain inputs keep
   * their own chords.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as { tagName?: string } | null
      const tag = target?.tagName?.toUpperCase() ?? ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (!event.ctrlKey && !event.metaKey && event.key === '?') {
        event.preventDefault()
        setHelpOpen(true)
        return
      }
      // Global bindings are user-editable, so match recorded combos instead of
      // hard-coded chords (requirement 1).
      const pressed = comboFromEvent({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      })
      if (pressed === null) return
      const combo = normalizeCombo(pressed)
      if (combo !== null && combo === normalizeCombo(shortcuts.palette)) {
        event.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (combo !== null && combo === normalizeCombo(shortcuts.objectSearch)) {
        event.preventDefault()
        setObjectSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [shortcuts])

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
  /**
   * Record one run in the history drawer (SQL-203).
   *
   * Local state updates immediately; the host append is best-effort so a broken
   * persistence layer never fails a query. Paging/sorting/filtering do not pass
   * through here — they re-run a statement that is already in the list.
   */
  const recordHistory = useCallback(
    (sql: string, outcome: { ok: boolean; durationMs: number; rowCount: number | null; errorCode?: string }) => {
      if (tabConnId === null || sql.trim() === '') return
      const entry: QueryHistoryEntry = {
        id: `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
        connId: tabConnId,
        sql,
        at: Date.now(),
        durationMs: outcome.durationMs,
        rowCount: outcome.rowCount,
        ok: outcome.ok,
        ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
      }
      setHistoryDoc(current => ({
        ...current,
        byConn: {
          ...current.byConn,
          [entry.connId]: insertHistory(current.byConn[entry.connId] ?? [], entry),
        },
      }))
      void api?.appendHistory?.(entry).catch(() => undefined)
    },
    [api, tabConnId],
  )

  const withConnection = useCallback(
    async (
      work: (connId: string, publish: (running: QueryState) => void) => Promise<QueryState>,
      /** SQL to record in query history; omitted for paging/sort/filter refetches. */
      historySql?: string,
    ) => {
      // The tab owns its data source (DataGrip consoles do too): reading the
      // global active id would run console_2 against whatever was selected last,
      // and the colour dot would lie (reported 2026-10-19).
      const connId = tabConnId
      if (connId === null) return
      // Pin both the "running" update and the final result to the tab that started
      // the run. Reading the active tab later would drop a slow result into whichever
      // console the user switched to meanwhile (reported 2026-10-19).
      const docId = activeDocId
      const seq = (runSeq.current += 1)
      const write = (next: QueryState): void => {
        // A cancelled or superseded run must not resurrect itself.
        if (seq === runSeq.current) setQueryAt(docId, next)
      }
      try {
        const next = await work(connId, write)
        write(next)
        // SQL-304: point the editor at the line the driver complained about.
        if (seq === runSeq.current) editorRef.current?.showErrorLine(next.error?.line ?? null)
        if (historySql !== undefined && seq === runSeq.current) {
          recordHistory(historySql, {
            ok: next.status === 'done',
            durationMs: next.result?.durationMs ?? 0,
            rowCount: next.result?.total ?? next.result?.rows.length ?? null,
            ...(next.error === null ? {} : { errorCode: next.error.code }),
          })
        }
      /* v8 ignore start -- query state helpers convert transport failures into QueryState errors */
      } catch (error) {
        // One catch covers every execution button: they all come through here.
        reportFailureToUser(error)
      }
      /* v8 ignore stop */
    },
    [tabConnId, activeDocId, setQueryAt, reportFailureToUser, recordHistory],
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
   * Open `sql` in a fresh console and run it there (SQL-218 / SQL-404).
   *
   * A new console keeps a half-written statement from disappearing under a
   * double-click. `prefix` names the tab (`data_2`, `overview_3`).
   */
  const openConsole = (prefix: string, sql: string): void => {
    if (api === undefined || tabConnId === null) return
    /* v8 ignore next 4 -- the tab cap is covered by the console-tab tests */
    if (documents.length >= MAX_TABS) {
      setNotice({ text: `标签已满（最多 ${String(MAX_TABS)} 个），先关一个再打开新控制台`, kind: 'warn' })
      return
    }
    const created = createTab(documents, tabConnId)
    const doc: DocumentTab = {
      ...created,
      title: `${prefix}_${String(documents.length + 1)}`,
      query: setSql(INITIAL_QUERY, sql),
      lastRunSql: sql,
    }
    setDocuments(current => [...current, doc])
    setActiveDocId(doc.id)
    setQueryAt(doc.id, { ...INITIAL_QUERY, sql, status: 'running', statementId: nextStatementId() })
    void (async () => {
      try {
        const outcome = await api.execute({ connId: tabConnId, sql, pageSize: 500, mode: 'direct' })
        setQueryAt(
          doc.id,
          outcome.ok
            ? { ...INITIAL_QUERY, sql, status: 'done', result: outcome, total: outcome.total }
            : {
                ...INITIAL_QUERY,
                sql,
                status: 'error',
                error: { code: outcome.error.code, message: readableDbError(outcome.error) },
              },
        )
      } catch (error) {
        setQueryAt(doc.id, {
          ...INITIAL_QUERY,
          sql,
          status: 'error',
          error: {
            code: 'OPEN_DATA_FAILED',
            message: readableDbError({ message: error instanceof Error ? error.message : String(error) }),
          },
        })
      }
    })()
  }

  /** DataGrip's `Edit Data` (F4): a console stands in for its data editor. */
  const openData = (sql: string): void => {
    openConsole('data', sql)
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

  /**
   * Run one source text the way the current editor semantics say.
   *
   * The editor keeps the whole script; only `source` (the statement under the
   * caret, the selection, or the full text for "run all") is sent to the server.
   * A run token keeps a superseded answer from overwriting newer state.
   */
  const runSource = (source: string): void => {
    const text = source.trim()
    if (text === '') return
    if (query.status === 'running' || (script?.running ?? false)) return
    if (requestParams(text, 'run')) return
    markRun(text)
    const changed = lastRunRef.current !== text
    lastRunRef.current = text
    // Old ordering/filters belong to the previous statement: keep them only when
    // the same text is re-run (refresh, paging), otherwise clear with a notice.
    const staleFilters = changed && (query.sort !== null || query.filters.length > 0)
    if (staleFilters) {
      setNotice({ text: '已清除上一条语句的排序/筛选', kind: 'warn' })
      setQueryAt(activeDocId, { ...query, sort: null, filters: [] })
    }
    if (splitStatements(text).length <= 1) {
      setScript(null)
      void withConnection((connId, publish) => executeQuery(api, query, connId, publish, text), text)
      return
    }
    void runScript(text)
  }

  /**
   * EXPLAIN the statement under the caret (SQL-306).
   *
   * Opens a new console with the plan, so the authored SQL and its existing
   * results stay untouched. The plan itself is a metadata read and runs raw.
   */
  const explainStatement = (sql: string): void => {
    if (api === undefined || tabConnId === null) return
    if (requestParams(sql, 'explain')) return
    /* v8 ignore next 4 -- the tab cap is covered by the console-tab tests */
    if (documents.length >= MAX_TABS) {
      setNotice({ text: `标签已满（最多 ${String(MAX_TABS)} 个），先关一个再查看执行计划`, kind: 'warn' })
      return
    }
    const text = /^\s*explain\b/i.test(sql) ? sql : `EXPLAIN ${sql}`
    const created = createTab(documents, tabConnId)
    const doc: DocumentTab = {
      ...created,
      title: `explain_${String(documents.length + 1)}`,
      query: setSql(INITIAL_QUERY, text),
      lastRunSql: text,
    }
    setDocuments(current => [...current, doc])
    setActiveDocId(doc.id)
    setQueryAt(doc.id, { ...INITIAL_QUERY, sql: text, status: 'running', statementId: nextStatementId() })
    void (async () => {
      try {
        const outcome = await api.execute({ connId: tabConnId, sql: text, pageSize: 500, raw: true })
        setQueryAt(
          doc.id,
          outcome.ok
            ? { ...INITIAL_QUERY, sql: text, status: 'done', result: outcome, total: outcome.total }
            : {
                ...INITIAL_QUERY,
                sql: text,
                status: 'error',
                error: { code: outcome.error.code, message: readableDbError(outcome.error) },
              },
        )
      } catch (error) {
        setQueryAt(doc.id, {
          ...INITIAL_QUERY,
          sql: text,
          status: 'error',
          error: {
            code: 'EXPLAIN_FAILED',
            message: readableDbError({ message: error instanceof Error ? error.message : String(error) }),
          },
        })
      }
    })()
  }

  /**
   * Format the selection — or the whole console when nothing is selected.
   *
   * One ordinary editor transaction, so a single Ctrl+Z undoes the whole
   * reformat (SQL-210).
   */
  const formatEditor = (target: RunTarget): void => {
    // A collapsed caret means "the whole console". Replacing only the caret
    // would insert a second copy of the script.
    if (target.from === target.to) {
      editorRef.current?.replaceRange(0, target.doc.length, formatSql(target.doc, { keywordCase }))
      return
    }
    editorRef.current?.replaceRange(target.from, target.to, formatSql(target.doc.slice(target.from, target.to), { keywordCase }))
  }

  /** Expand `*` into the column list of the current statement (SQL-211). */
  const expandEditorStar = (target: RunTarget): void => {
    const replacement = expandStar(target.doc, { from: target.from, to: target.to }, schemaIndex)
    if (replacement === null) {
      setNotice({ text: '无法展开：这里不是 *，或无法确定唯一的目标表', kind: 'warn' })
      return
    }
    editorRef.current?.replaceRange(target.from, target.to, replacement)
  }

  /** Editor target for palette commands (state is current; the editor owns the text). */
  const paletteTarget = (): RunTarget => {
    const range = editorRef.current?.getSelectionRange() ?? { from: 0, to: 0 }
    return {
      doc: query.sql,
      selection: range.from === range.to ? '' : query.sql.slice(range.from, range.to),
      cursor: editorRef.current?.getCursor() ?? 0,
      from: range.from,
      to: range.to,
    }
  }

  /** Surface where a "send to chat" attempt ended up (SQL-405). */
  const notifyChat = (result: { readonly mode: 'chat' | 'clipboard'; readonly ok: boolean; readonly reason?: string }): void => {
    if (result.mode === 'chat') {
      setNotice({ text: '已插入聊天输入框', kind: 'warn' })
      return
    }
    setNotice({ text: result.ok ? '聊天框不可用，已复制到剪贴板' : (result.reason ?? '发送失败'), kind: result.ok ? 'warn' : 'error' })
  }

  /** Text sent by the SQL actions: the statement under the caret, or the document. */
  const chatSqlText = (): string => {
    const target = paletteTarget()
    const current = statementAt(target.doc, target.cursor)
    return current === null ? target.doc : current.text
  }

  /** Hand one failure plus its SQL to the chat composer (SQL-405). */
  const sendErrorToChat = (error: { readonly code: string; readonly message: string }, sql: string): void => {
    const text = `SQL 执行报错：${error.message}（${error.code}）\n\n\`\`\`sql\n${sql}\n\`\`\``
    void sendToChat(text, sessionId === undefined ? {} : { sessionId }).then(notifyChat)
  }

  /** Commands shown in the palette; the shortcuts stay on their own keys. */
  const commands: readonly CommandAction[] = [
    {
      id: 'run-statement',
      title: '执行光标语句',
      keywords: 'run execute Ctrl+Enter',
      run: () => {
        const target = paletteTarget()
        const current = statementAt(target.doc, target.cursor)
        runSource(current === null ? target.doc : current.text)
      },
    },
    { id: 'run-all', title: '执行全部语句', keywords: 'run all Ctrl+Shift+Enter', run: () => { runSource(query.sql) } },
    {
      id: 'rerun',
      title: '重跑上次',
      keywords: 'rerun Ctrl+Alt+Enter',
      run: () => {
        if (lastRunRef.current !== null) runSource(lastRunRef.current)
      },
    },
    { id: 'format', title: '格式化 SQL', keywords: 'format Ctrl+Alt+L', run: () => { formatEditor(paletteTarget()) } },
    { id: 'expand-star', title: '展开星号', keywords: 'expand star Ctrl+Alt+S', run: () => { expandEditorStar(paletteTarget()) } },
    {
      id: 'explain',
      title: '查看执行计划',
      keywords: 'explain plan Ctrl+Shift+E',
      run: () => {
        const target = paletteTarget()
        const current = statementAt(target.doc, target.cursor)
        explainStatement(current === null ? target.doc.trim() : current.text)
      },
    },
    { id: 'history', title: '查询历史与收藏', keywords: 'history Ctrl+Shift+H', run: () => { setHistoryOpen(true) } },
    { id: 'object-search', title: '全局对象搜索', keywords: 'search table column Ctrl+Shift+O', run: () => { setObjectSearchOpen(true) } },
    {
      id: 'agent-explain',
      title: 'AI 结对：解释当前语句',
      keywords: 'agent explain pair 复制给 AI',
      run: () => {
        const target = paletteTarget()
        const current = statementAt(target.doc, target.cursor)
        copyText(explainSqlPrompt(current === null ? target.doc : current.text))
        setNotice({ text: '已复制解释请求，粘贴到对话里即可', kind: 'warn' })
      },
    },
    {
      id: 'agent-optimize',
      title: 'AI 结对：审查 / 优化当前语句',
      keywords: 'agent optimize review pair',
      run: () => {
        const target = paletteTarget()
        const current = statementAt(target.doc, target.cursor)
        copyText(optimizeSqlPrompt(current === null ? target.doc : current.text))
        setNotice({ text: '已复制审查请求，粘贴到对话里即可', kind: 'warn' })
      },
    },
    { id: 'format-case', title: '切换格式化关键字大小写', keywords: 'format keyword case upper lower preserve 大写 小写', run: () => { setKeywordCase(current => { const next: KeywordCase = current === 'upper' ? 'lower' : current === 'lower' ? 'preserve' : 'upper'; const label = next === 'upper' ? '大写' : next === 'lower' ? '小写' : '保持原样'; setNotice({ text: `格式化关键字：${label}`, kind: 'warn' }); return next }) } },
    {
      id: 'chat-send-sql',
      title: '发送当前 SQL 到聊天框',
      keywords: 'chat send 发送 聊天',
      run: () => {
        void sendToChat(chatSqlText(), sessionId === undefined ? {} : { sessionId }).then(notifyChat)
      },
    },
    {
      id: 'chat-send-error',
      title: '发送错误详情到聊天框',
      keywords: 'chat send error 发送 错误',
      run: () => {
        const error = query.error
        if (error === null) {
          setNotice({ text: '当前没有错误可发送', kind: 'warn' })
          return
        }
        sendErrorToChat(error, lastRunRef.current ?? query.sql)
      },
    },
    {
      id: 'chat-diff-clipboard',
      title: '粘贴 Agent 提案（接受/拒绝 diff）',
      keywords: 'agent diff proposal 提案 接受 拒绝',
      run: () => {
        const read = typeof navigator === 'undefined' ? undefined : navigator.clipboard?.readText
        if (typeof read !== 'function') {
          setNotice({ text: '无法读取剪贴板（先复制 agent 的 SQL 提案）', kind: 'error' })
          return
        }
        void read.call(navigator.clipboard).then(text => {
          setDiffProposal({ original: query.sql, proposal: text })
        }).catch(() => {
          setNotice({ text: '读取剪贴板失败', kind: 'error' })
        })
      },
    },
    { id: 'lint-toggle', title: '开启/关闭诊断（lint）', keywords: 'diagnostics lint 波浪线 开关', run: () => { setLintEnabled(current => { setNotice({ text: current ? '诊断已关闭' : '诊断已开启', kind: 'warn' }); return !current }) } },
    { id: 'help', title: '快捷键说明', keywords: 'shortcuts keys help ?', run: () => { setHelpOpen(true) } },
  ]

  const runningNow = query.status === 'running' || (script?.running ?? false)
  const runLabel = runningNow ? '取消' : aimLabel
  const editorReady = tabConnId !== null && query.sql.trim() !== ''

  const cancelActive = (): void => {
    // A running script cancels its current statement; the driver rejects it
    // and the loop stops (SQL-107).
    if (script?.running === true) {
      runSeq.current += 1
      for (const statementId of scriptIdsRef.current) {
        void api.cancel(statementId).catch(reportFailureToUser)
      }
      return
    }
    // Invalidate the in-flight run before asking the server to stop: a late
    // answer must not overwrite "查询已取消".
    runSeq.current += 1
    void cancelQuery(api, query).then(setQuery).catch(reportFailureToUser)
  }

  const runActive = (): void => {
    const target = paletteTarget()
    if (target.selection.trim() !== '') {
      runSource(target.selection)
      return
    }
    const current = statementAt(target.doc, target.cursor)
    runSource(current === null ? target.doc : current.text)
  }

  const connectionBar = (
    <ConnectionBar
      connections={state.connections}
      activeId={state.activeId}
      testingId={state.testingId}
      verdicts={state.verdicts}
      onSelect={connId => {
        // The console follows the selector, the way a data-source change
        // rebinds the console it sits in.
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
      onOpenShortcuts={() => {
        setShortcutsOpen(true)
      }}
    />
  )

  return (
    <section className={styles.sqlWorkbenchPanel} data-sql-workbench="" data-session-id={sessionId} data-phase={state.phase} ref={panelRef}>
      {hasConnections ? null : connectionBar}

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
                <WorkbenchPanel id="objects" headless>
                  <span className={styles.srOnly} data-sql-panel-meta="objects">
                    {schemaLoading
                      ? '读取中…'
                      : schema === undefined
                        ? (schemaError === undefined ? '未加载' : readable(schemaError))
                        : `${describeSchema(schema.tables)} · ${schema.source === 'show' ? 'SHOW' : 'information_schema'}`}
                  </span>
                  <div className={styles.treeFill}>
                    <SchemaTree
                      tables={schema?.tables ?? []}
                      {...(schemaNote === undefined ? {} : { note: schemaNote })}
                      loading={schemaLoading}
                      showRefresh
                      {...(connectionName === undefined ? {} : { connectionName })}
                      onRefresh={refreshSchema}
                      onInsert={name => {
                        editorRef.current?.insert(name)
                      }}
                      onInsertSql={sql => {
                        editorRef.current?.insert(sql)
                      }}
                      onOverview={table => {
                        setOverviewTable(table)
                      }}
                      onJoin={table => {
                        setJoinFrom(table)
                        setObjectSearchOpen(true)
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
                  trailing={(
                    <>
                      {connectionBar}
                      <button
                        type="button"
                        className={styles.primaryButton}
                        data-sql-run=""
                        aria-label={runLabel}
                        title={runLabel === '取消'
                          ? `取消正在执行的语句（${displayCombo(shortcuts.cancel)}）`
                          : `执行光标所在语句（${displayCombo(shortcuts.run)}；有选中则只跑选段）`}
                        disabled={runLabel !== '取消' && !editorReady}
                        onClick={event => {
                          // The second click of a double-click arrives after the
                          // button has already become 取消. detail > 1 is that click.
                          if (runningNow) {
                            if (event.detail > 1) return
                            cancelActive()
                            return
                          }
                          runActive()
                        }}
                      >
                        {runLabel}
                      </button>
                      <OverflowMenu label="更多" ariaLabel="更多查询操作">
                          <button
                            type="button"
                            className={styles.button}
                            aria-label="执行全部"
                            disabled={!editorReady || runningNow}
                            onClick={() => {
                              runSource(paletteTarget().doc)
                            }}
                          >
                            全部
                          </button>
                          <button
                            type="button"
                            className={styles.button}
                            aria-label="解释计划"
                            disabled={!editorReady || runningNow}
                            onClick={() => {
                              const target = paletteTarget()
                              const current = statementAt(target.doc, target.cursor)
                              explainStatement(current === null ? target.doc.trim() : current.text)
                            }}
                          >
                            计划
                          </button>
                          <button type="button" className={styles.button} aria-label="历史" onClick={() => { setHistoryOpen(true) }}>
                            历史
                          </button>
                          <button
                            type="button"
                            className={styles.button}
                            aria-label="格式化"
                            disabled={tabConnId === null || query.sql.trim() === ''}
                            onClick={() => {
                              formatEditor(paletteTarget())
                            }}
                          >
                            格式
                          </button>
                          <button
                            type="button"
                            className={styles.button}
                            aria-label="展开星号"
                            disabled={tabConnId === null || query.sql.trim() === ''}
                            onClick={() => {
                              expandEditorStar(paletteTarget())
                            }}
                          >
                            展开*
                          </button>
                          <button
                            type="button"
                            className={styles.button}
                            aria-label="复制全部"
                            disabled={tabConnId === null || query.sql === ''}
                            onClick={() => {
                              copyText(query.sql)
                            }}
                          >
                            复制
                          </button>
                          <button
                            type="button"
                            className={styles.button}
                            aria-label="清空"
                            disabled={tabConnId === null || query.sql === ''}
                            onClick={() => {
                              setQuery(setSql(query, ''))
                            }}
                          >
                            清空
                          </button>
                      </OverflowMenu>
                    </>
                  )}
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
                    lintEnabled={lintEnabled}
                    shortcuts={shortcuts}
                    {...(schemaIndex === undefined ? {} : { schema: schemaIndex })}
                    onChange={sql => {
                      setQuery(setSql(query, sql))
                    }}
                    onAim={aim => {
                      const label = runControlLabel(aim.doc, aim.cursor, aim.from, aim.to)
                      setAimLabel(prev => (prev === label ? prev : label))
                    }}
                    onRun={target => {
                      if (target.selection.trim() !== '') {
                        runSource(target.selection)
                        return
                      }
                      const current = statementAt(target.doc, target.cursor)
                      runSource(current === null ? target.doc : current.text)
                    }}
                    onRunAll={target => {
                      runSource(target.doc)
                    }}
                    onRerun={() => {
                      if (lastRunRef.current !== null) runSource(lastRunRef.current)
                    }}
                    onExplain={target => {
                      const current = statementAt(target.doc, target.cursor)
                      explainStatement(current === null ? target.doc.trim() : current.text)
                    }}
                    onHistory={() => {
                      setHistoryOpen(true)
                    }}
                    onFormat={target => {
                      formatEditor(target)
                    }}
                    onExpandStar={target => {
                      expandEditorStar(target)
                    }}
                    onCancel={cancelActive}
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

              <WorkbenchPanel id="result" headless>
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
                        void withConnection((connId, publish) => executeQuery(api, query, connId, publish), query.sql)
                      }}
                      onFilter={(_index, column, filter) => {
                        // Server-side filtering needs the paged wrapper (the
                        // direct mode deliberately runs the SQL as authored).
                        const next = [
                          ...query.filters.filter(entry => entry.column !== column),
                          ...(filter === null ? [] : [filter]),
                        ]
                        const withFilters = { ...setFilters(query, next), mode: 'paged' as const }
                        setQuery(withFilters)
                        void withConnection((connId, publish) => executeQuery(api, withFilters, connId, publish))
                      }}
                      onClearFilters={() => {
                        const cleared = { ...setFilters(query, []), mode: 'paged' as const }
                        setQuery(cleared)
                        void withConnection((connId, publish) => executeQuery(api, cleared, connId, publish))
                      }}
                      onCount={() => {
                        // "统计总数": switch this console to the browsable mode
                        // and re-run once, so the pager replaces the direct bar.
                        const paged = setMode(query, 'paged')
                        setQuery(paged)
                        void withConnection((connId, publish) => executeQuery(api, paged, connId, publish))
                      }}
                      errorActions={() => {
                        // ScriptResults only asks for steps on a failed tab, so
                        // the error exists here.
                        const err = query.error as NonNullable<typeof query.error>
                        return {
                          line: err.line ?? null,
                          onLocate: line => {
                            editorRef.current?.showErrorLine(line)
                          },
                          onExplain: () => {
                            // A failure implies a completed run, so the last SQL exists.
                            explainStatement(lastRunRef.current as string)
                          },
                        }
                      }}
                      onSendChat={() => {
                        const error = query.error as NonNullable<typeof query.error>
                        // A failure implies a completed run, so the last SQL exists.
                        sendErrorToChat(error, lastRunRef.current as string)
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
                    errorActions={index => {
                      // Only failed tabs get this hook, so the index is valid.
                      const tab = script.tabs[index] as ScriptTab
                      return {
                        onExplain: () => {
                          explainStatement(tab.sql)
                        },
                      }
                    }}
                    onRenameTab={(index, title) => {
                      setScriptAt(activeDocId, {
                        ...script,
                        tabs: script.tabs.map((tab, at) => (at === index ? { ...tab, title } : tab)),
                      })
                    }}
                    onPinTab={index => {
                      setScriptAt(activeDocId, {
                        ...script,
                        tabs: script.tabs.map((tab, at) => (at === index ? { ...tab, pinned: tab.pinned !== true } : tab)),
                      })
                    }}
                    onSendChat={index => {
                      const tab = script.tabs[index] as ScriptTab
                      if (tab.error !== undefined) sendErrorToChat(tab.error, tab.sql)
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

      {historyOpen ? (
        <div className={styles.historyOverlay} data-sql-history-overlay="">
          <HistoryPanel
            entries={Object.values(historyDoc.byConn).flat()}
            favorites={favorites}
            connId={tabConnId}
            onInsert={sql => {
              editorRef.current?.insert(sql)
              setHistoryOpen(false)
            }}
            onReplace={sql => {
              setQueryAt(activeDocId, { ...query, sql })
              setHistoryOpen(false)
            }}
            onPin={entry => {
              const next = addFavorite(favorites, favoriteFromHistory(entry))
              setFavorites(next)
              void api?.saveFavorites?.(toFavoritesDocument(next)).catch(() => undefined)
            }}
            onRemoveFavorite={id => {
              const next = removeFavorite(favorites, id)
              setFavorites(next)
              void api?.saveFavorites?.(toFavoritesDocument(next)).catch(() => undefined)
            }}
            onClose={() => {
              setHistoryOpen(false)
            }}
          />
        </div>
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          open
          actions={commands}
          onClose={() => {
            setPaletteOpen(false)
          }}
        />
      ) : null}

      {objectSearchOpen ? (
        <ObjectSearch
          open
          tables={schema?.tables ?? []}
          onClose={() => {
            setObjectSearchOpen(false)
            setJoinFrom(null)
          }}
          onPickTable={name => {
            editorRef.current?.insert(name)
            setObjectSearchOpen(false)
          }}
          {...(joinFrom === null
            ? {}
            : {
                onPickTableObject: (table: SchemaTable) => {
                  editorRef.current?.insert(joinSql(joinFrom, table))
                  setJoinFrom(null)
                  setObjectSearchOpen(false)
                },
              })}
          onPickColumn={(_table, column) => {
            editorRef.current?.insert(column)
            setObjectSearchOpen(false)
          }}
        />
      ) : null}

      {helpOpen ? (
        <ShortcutsHelp
          open
          onClose={() => {
            setHelpOpen(false)
          }}
        />
      ) : null}

      {pendingParams === null ? null : (
        <ParamsForm
          open
          names={pendingParams.names}
          onSubmit={submitParams}
          onCancel={() => {
            setPendingParams(null)
          }}
        />
      )}

      {shortcutsOpen ? (
        <ShortcutSettings
          open
          value={shortcuts}
          onChange={next => {
            setShortcuts(next)
            saveSettings(next)
            setNotice({ text: '快捷键已保存', kind: 'warn' })
          }}
          onClose={() => {
            setShortcutsOpen(false)
          }}
        />
      ) : null}

      {overviewTable === null ? null : (
        <TableOverview
          open
          table={overviewTable}
          load={async sql => {
            /* v8 ignore next -- the dialog only opens with a bound tab */
            if (api === undefined || tabConnId === null) throw new Error('当前标签还没有绑定连接')
            const outcome = await api.execute({ connId: tabConnId, sql, pageSize: 500, mode: 'direct' })
            if (!outcome.ok) throw new Error(readableDbError(outcome.error))
            return outcome
          }}
          loadDdl={async () => {
            const table = overviewTable
            return loadDdlText({
              schema: table.schema ?? '',
              table: table.name,
              ...(table.kind === undefined ? {} : { kind: table.kind }),
            })
          }}
          onClose={() => {
            setOverviewTable(null)
          }}
        />
      )}

      {diffProposal === null ? null : (
        <DiffProposal
          open
          original={diffProposal.original}
          proposal={diffProposal.proposal}
          onAccept={sql => {
            editorRef.current?.replaceRange(0, query.sql.length, sql)
            setDiffProposal(null)
            setNotice({ text: '已接受 Agent 提案并替换编辑器内容', kind: 'warn' })
          }}
          onReject={() => {
            setDiffProposal(null)
          }}
        />
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

/**
 * Table overview dialog (SQL-404 upgrade).
 *
 * One object, three answers in one bounded card: per-column null rates, a small
 * sample page and the object's DDL. The panel owns connections and statement
 * execution, so this component is props-driven: it receives the two loaders and
 * only renders — opening a dialog must not create a console or run anything the
 * caller did not ask for.
 *
 * The card is capped (`max-height: 78vh`, `max-width: min(900px, 92vw)`) and the
 * content area scrolls, so a 100-column table or a long DDL can never push the
 * dialog past the viewport. Styles are inline `--dsw-alias-*` tokens on purpose:
 * the panel owns the stylesheet and a second surface must not grow it.
 */

import * as React from 'react'

import type { ReactElement } from 'react'

import type { ExecuteResponse } from '../../execute/core.ts'
import type { SchemaTable } from '../completion.ts'
import { columnKind, formatCell, formatNumber } from '../format.ts'
import { nullRateText, overviewSampleSql, overviewStatsSql, tableKey } from '../schema-tree.ts'

export interface TableOverviewProps {
  /** Whether the dialog is on screen; closed renders nothing (and loads nothing). */
  readonly open: boolean
  /** Object the dialog describes; its columns drive the statistics table. */
  readonly table: SchemaTable
  /** Runs one statement for the dialog; statistics and sample share it. */
  readonly load: (sql: string) => Promise<ExecuteResponse>
  /** `SHOW CREATE …` text for the object; rejects when the driver refuses. */
  readonly loadDdl: () => Promise<string>
  readonly onClose: () => void
}

/** Sample rows shown; matches the LIMIT `overviewSampleSql` asks for. */
export const OVERVIEW_SAMPLE_ROWS = 20

/** The three independent loads, each with its own error text. */
type LoadState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly value: T }
  | { readonly status: 'error'; readonly message: string }

/** A load bound to the key it answers (the SQL, or the object for the DDL). */
interface Keyed<T> {
  readonly key: string
  readonly state: LoadState<T>
}

interface StatsData {
  readonly total: number | null
  readonly nonNull: readonly (number | null)[]
}

/** Empty per-load result: the dialog opens in this state. */
function initialKeyed<T>(): Keyed<T> {
  return { key: '', state: { status: 'loading' } }
}

/** Readable text for anything a loader rejects with. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A driver count, or `null` when the cell is not a usable number. */
function toCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Read the statistics row: `[total, count1, count2, …]`.
 *
 * Index-based on purpose: the aliases are ours, but a driver is free to echo a
 * different label, and the column order is the contract.
 *
 * @param result - Response of `overviewStatsSql`.
 * @param table - Object whose columns the counts belong to.
 */
function statsOf(result: ExecuteResponse, table: SchemaTable): StatsData {
  const row = result.rows[0]
  return {
    total: toCount(row?.[0]),
    nonNull: table.columns.map((_column, index) => toCount(row?.[index + 1])),
  }
}

const STAT_HEADERS = ['列名', '类型', '非空', '空值', '空值率'] as const

const overlayStyle = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '16px',
  background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 62%, transparent)',
  zIndex: 60,
  // Floating layer: rebind the scrollbar pair to the l2 tokens (AGENTS UI rule).
  '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2)',
  '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2)',
} as unknown as React.CSSProperties

const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'min(900px, 92vw)',
  maxWidth: 'min(900px, 92vw)',
  maxHeight: '78vh',
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 'var(--sql-radius, 10px)',
  boxShadow: '0 18px 48px color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 'var(--dsw-font-xs-13)',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  padding: '10px 14px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
}

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--dsw-font-s-14)',
  fontWeight: 600,
}

const closeStyle: React.CSSProperties = {
  padding: '3px 10px',
  color: 'var(--dsw-alias-label-primary)',
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 'var(--sql-radius, 8px)',
  cursor: 'pointer',
  font: 'inherit',
}

const bodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '14px',
  padding: '12px 14px',
  minHeight: 0,
  overflow: 'auto',
}

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
}

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 'var(--dsw-font-s-12)',
  fontWeight: 600,
}

const mutedStyle: React.CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-tertiary)',
}

const errorStyle: React.CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-state-error-primary)',
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 'var(--dsw-font-xs-13)',
}

const thStyle: React.CSSProperties = {
  padding: '4px 8px',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-bg-base)',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
}

const tdStyle: React.CSSProperties = {
  padding: '3px 8px',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
}

const numberStyle: React.CSSProperties = {
  ...tdStyle,
  textAlign: 'right',
  fontFamily: 'var(--ds-font-family-code)',
}

const nullCellStyle: React.CSSProperties = {
  ...tdStyle,
  color: 'var(--dsw-alias-label-tertiary)',
}

const scrollStyle: React.CSSProperties = {
  overflowX: 'auto',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 'var(--sql-radius, 8px)',
}

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  overflowX: 'auto',
  fontFamily: 'var(--ds-font-family-code)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-bg-base)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 'var(--sql-radius, 8px)',
}

/**
 * Table overview dialog.
 *
 * @param props - Visibility, the object, the two loaders and the close callback.
 */
export function TableOverview({ open, table, load, loadDdl, onClose }: TableOverviewProps): ReactElement | null {
  const statsSql = overviewStatsSql(table)
  const sampleSql = overviewSampleSql(table)
  const objectKey = tableKey(table)

  const [stats, setStats] = React.useState<Keyed<StatsData>>(initialKeyed)
  const [sample, setSample] = React.useState<Keyed<ExecuteResponse>>(initialKeyed)
  const [ddl, setDdl] = React.useState<Keyed<string>>(initialKeyed)

  /**
   * Latest injected loaders.
   *
   * The panel may pass fresh arrow functions on every render; the loads below
   * are keyed by the SQL they answer instead, so a parent re-render must not
   * fire two extra queries.
   */
  const loaders = React.useRef({ load, loadDdl })
  React.useEffect(() => {
    loaders.current = { load, loadDdl }
  }, [load, loadDdl])

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setStats({ key: statsSql, state: { status: 'loading' } })
    setSample({ key: sampleSql, state: { status: 'loading' } })
    setDdl({ key: objectKey, state: { status: 'loading' } })

    void (async () => {
      try {
        const result = await loaders.current.load(statsSql)
        if (!cancelled) setStats({ key: statsSql, state: { status: 'done', value: statsOf(result, table) } })
      } catch (error) {
        if (!cancelled) setStats({ key: statsSql, state: { status: 'error', message: messageOf(error) } })
      }
    })()

    void (async () => {
      try {
        const result = await loaders.current.load(sampleSql)
        if (!cancelled) setSample({ key: sampleSql, state: { status: 'done', value: result } })
      } catch (error) {
        if (!cancelled) setSample({ key: sampleSql, state: { status: 'error', message: messageOf(error) } })
      }
    })()

    void (async () => {
      try {
        const text = await loaders.current.loadDdl()
        if (!cancelled) setDdl({ key: objectKey, state: { status: 'done', value: text } })
      } catch (error) {
        if (!cancelled) setDdl({ key: objectKey, state: { status: 'error', message: messageOf(error) } })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, statsSql, sampleSql, objectKey])

  // Esc closes wherever focus is: the dialog is a layer, not a focus trap.
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  const statsState: LoadState<StatsData> = stats.key === statsSql ? stats.state : { status: 'loading' }
  const sampleState: LoadState<ExecuteResponse> = sample.key === sampleSql ? sample.state : { status: 'loading' }
  const ddlState: LoadState<string> = ddl.key === objectKey ? ddl.state : { status: 'loading' }
  const displayName =
    table.schema === undefined || table.schema === '' ? table.name : `${table.schema}.${table.name}`

  return (
    <div style={overlayStyle} data-sql-table-overview-overlay="">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`表概览 ${displayName}`}
        data-sql-table-overview=""
        style={cardStyle}
      >
        <header style={headerStyle}>
          <h2 style={titleStyle}>表概览 · {displayName}</h2>
          <button type="button" style={closeStyle} aria-label="关闭表概览" data-overview-close="" onClick={onClose}>
            关闭
          </button>
        </header>

        <div style={bodyStyle} data-overview-body="">
          <section style={sectionStyle} data-overview-section="stats">
            <h3 style={sectionTitleStyle}>统计</h3>
            {statsState.status === 'loading' ? (
              <p style={mutedStyle} data-overview-stats-loading="">
                统计加载中…
              </p>
            ) : statsState.status === 'error' ? (
              <p role="alert" style={errorStyle}>
                统计加载失败：{statsState.message}
              </p>
            ) : (
              <>
                <p style={mutedStyle}>
                  总行数：{statsState.value.total === null ? '—' : formatNumber(statsState.value.total)}
                </p>
                {table.columns.length === 0 ? (
                  <p style={mutedStyle}>该对象没有列元数据，只能显示总行数</p>
                ) : (
                  <table style={tableStyle} data-overview-stats="">
                    <thead>
                      <tr>
                        {STAT_HEADERS.map(header => (
                          <th key={header} style={thStyle}>
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {table.columns.map((column, index) => {
                        const nonNull = statsState.value.nonNull[index] ?? null
                        const nulls =
                          nonNull === null || statsState.value.total === null
                            ? null
                            : Math.max(0, statsState.value.total - nonNull)
                        return (
                          <tr key={column.name} data-overview-column={column.name}>
                            <td style={tdStyle}>{column.name}</td>
                            <td style={tdStyle}>{column.type}</td>
                            <td style={numberStyle}>{nonNull === null ? '—' : formatNumber(nonNull)}</td>
                            <td style={numberStyle}>{nulls === null ? '—' : formatNumber(nulls)}</td>
                            <td style={numberStyle}>{nullRateText(nonNull ?? 0, statsState.value.total ?? 0)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </section>

          <section style={sectionStyle} data-overview-section="sample">
            <h3 style={sectionTitleStyle}>样例（前 {String(OVERVIEW_SAMPLE_ROWS)} 行）</h3>
            {sampleState.status === 'loading' ? (
              <p style={mutedStyle}>样例加载中…</p>
            ) : sampleState.status === 'error' ? (
              <p role="alert" style={errorStyle}>
                样例加载失败：{sampleState.message}
              </p>
            ) : sampleState.value.rows.length === 0 ? (
              <p style={mutedStyle}>没有样例数据</p>
            ) : (
              <div style={scrollStyle} data-overview-sample-scroll="">
                <table style={tableStyle} data-overview-sample="">
                  <thead>
                    <tr>
                      {sampleState.value.columns.map(column => (
                        <th key={column.name} style={thStyle}>
                          {column.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sampleState.value.rows.slice(0, OVERVIEW_SAMPLE_ROWS).map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {sampleState.value.columns.map((column, columnIndex) => {
                          const cell = formatCell(row[columnIndex], columnKind(column.typeName))
                          return (
                            <td key={column.name} style={cell.isNull ? nullCellStyle : tdStyle}>
                              {cell.text}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section style={sectionStyle} data-overview-section="ddl">
            <h3 style={sectionTitleStyle}>DDL</h3>
            {ddlState.status === 'loading' ? (
              <p style={mutedStyle}>DDL 加载中…</p>
            ) : ddlState.status === 'error' ? (
              <p role="alert" style={errorStyle}>
                DDL 读取失败：{ddlState.message}
              </p>
            ) : ddlState.value === '' ? (
              <p style={mutedStyle}>数据库没有返回 DDL</p>
            ) : (
              <pre style={preStyle} data-overview-ddl="">
                {ddlState.value}
              </pre>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

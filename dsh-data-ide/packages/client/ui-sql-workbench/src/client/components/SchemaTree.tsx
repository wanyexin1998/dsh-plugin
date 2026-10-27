import * as React from 'react'

import type { ReactElement } from 'react'

import type { SchemaTable } from '../completion.ts'
import {
  type DdlTarget,
  type MenuItem,
  MENU_SIZE,
  columnKey,
  ddlTitle,
  filterGroups,
  groupBySchema,
  groupKey,
  menuPosition,
  openDataSql,
  qualifiedName,
  columnListSql,
  schemaKey,
  selectFromTableSql,
  tableKey,
} from '../schema-tree.ts'
import { classes as styles } from '../styles.ts'

export interface SchemaTreeProps {
  readonly tables: readonly SchemaTable[]
  /** Why the listing is empty or partial; shown inline, not as an error. */
  readonly note?: string
  readonly loading: boolean
  /** Data source the tree belongs to, for the root caption. */
  readonly connectionName?: string
  /** Insert the object's name at the editor's caret. */
  readonly onInsert: (name: string) => void
  /** DataGrip's `Edit Data` (F4): we run `SELECT * …` in the console. */
  readonly onOpenData: (sql: string) => void
  /**
   * Show the object's DDL.
   *
   * The panel opens it in a console tab (DataGrip's *Go to DDL* does the same);
   * a refusal surfaces as a corner notice, not a dialog over the tree.
   */
  readonly onShowDdl: (target: DdlTarget) => void
  readonly onCopy: (text: string) => void
  readonly onRefresh: () => void
  /** Insert generated SQL at the editor caret (`生成 SELECT` / `添加全部列`). */
  readonly onInsertSql?: (sql: string) => void
  /** Open the table overview dialog (row count, null rate, sample, DDL). */
  readonly onOverview?: (table: SchemaTable) => void
  /** Pick a second table for a JOIN skeleton (SQL-212). */
  readonly onJoin?: (table: SchemaTable) => void
  /**
   * Keep the tree's own refresh button.
   *
   * The workbench panel header offers the same action now, so the embedded tree
   * passes `false` and the filter stays the only thing in its local toolbar.
   */
  readonly showRefresh?: boolean
}

interface OpenMenu {
  readonly x: number
  readonly y: number
  readonly title: string
  readonly items: readonly MenuItem[]
}

/**
 * Hierarchy tints (需求2): inline, so the depth is legible without editing the
 * stylesheet (the grid work owns it) and without a single literal colour — every
 * value is a semantic `--dsw-alias-*` token, which is what keeps light/dark
 * switching honest (AC-7).
 *
 * Read top-down: data source (primary, weightier) → schema row (secondary on a
 * raised strip) → Tables/Views folder (secondary) → object (primary) → column
 * name (secondary) → column type (tertiary). Deliberately three steps and no
 * more: at 300px wide, more contrast would look like decoration, not structure.
 */
const tint = {
  root: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
  schemaRow: {
    color: 'var(--dsw-alias-label-secondary)',
    backgroundColor: 'var(--dsw-alias-bg-layer-2)',
  },
  schemaName: { color: 'var(--dsw-alias-label-secondary)' },
  folder: { color: 'var(--dsw-alias-label-secondary)' },
  objectName: { color: 'var(--dsw-alias-label-primary)' },
  columnName: { color: 'var(--dsw-alias-label-secondary)' },
  columnType: { color: 'var(--dsw-alias-label-tertiary)' },
} satisfies Record<string, React.CSSProperties>


/**
 * Object browser for the active connection.
 *
 * Hierarchy follows DataGrip's Database Explorer: data source → schema →
 * Tables/Views → object → columns. The actions on the object node are the ones
 * its explorer docs list (`Edit Data`, `Jump to Query Console`, `Go to DDL`,
 * `Copy Reference`, `Refresh`), mapped onto what this panel can actually do:
 * a console is our data editor, so `Edit Data` writes the statement into the
 * editor and runs it.
 *
 * Not built (and not claimed): keys, indexes, triggers and `Server Objects`.
 * They need introspection this plugin does not do yet.
 */
export function SchemaTree({
  tables,
  note,
  loading,
  connectionName,
  onInsert,
  onOpenData,
  onShowDdl,
  onCopy,
  onRefresh,
  onInsertSql,
  onOverview,
  onJoin,
  showRefresh = true,
}: SchemaTreeProps): ReactElement {
  const [filter, setFilter] = React.useState('')
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set())
  const [menu, setMenu] = React.useState<OpenMenu | null>(null)
  const needle = filter.trim()
  const groups = React.useMemo(() => filterGroups(groupBySchema(tables), needle), [tables, needle])
  // A single namespace needs no extra level; the schema row would be a lone
  // wrapper around the two folders.
  const named = groups.length > 1 || (groups[0]?.schema ?? '') !== ''

  /**
   * Open what the user came for: the first schema and its Tables folder.
   *
   * Seeded per *namespace composition*, not per array identity: a refresh that
   * brings the same schemas must not spring open the folders the user just
   * collapsed, while a tree for another connection arrives unfolded.
   */
  const signature = tables.length === 0
    ? '\u0000empty'
    : groupBySchema(tables).map(group => group.schema).join('\u0001')
  const seeded = React.useRef<string | null>(null)
  /** The menu element, so its own pointerdown does not count as "outside". */
  const menuRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (seeded.current === signature) return
    seeded.current = signature
    const first = groupBySchema(tables)[0]
    if (first === undefined) return
    const keys = new Set<string>()
    if (first.schema !== '') keys.add(schemaKey(first.schema))
    // Open the folder that actually has something in it: a schema made only of
    // views should not arrive looking empty.
    if (first.tables.length > 0) keys.add(groupKey(first.schema, 'table'))
    else if (first.views.length > 0) keys.add(groupKey(first.schema, 'view'))
    setOpen(current => new Set([...current, ...keys]))
  }, [signature, tables])

  // Menus close the way the platform's do: outside click, Escape, or scrolling
  // the list out from under them.
  React.useEffect(() => {
    if (menu === null) return
    // A click inside the menu must survive its own pointerdown: closing here
    // unmounts the button before `click` fires, which is why every item did
    // nothing at all.
    const close = (event?: Event): void => {
      const node = menuRef.current
      const target = event?.target
      if (node !== null && target instanceof Node && node.contains(target)) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close as EventListener, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close as EventListener, true)
    return () => {
      window.removeEventListener('pointerdown', close as EventListener, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close as EventListener, true)
    }
  }, [menu])

  const toggle = (key: string): void => {
    setOpen(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const isOpen = (key: string): boolean => open.has(key) || needle !== ''

  const openMenu = (event: React.MouseEvent, title: string, build: () => readonly MenuItem[]): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, title, items: build() })
  }

  const objectItems = (table: SchemaTable): readonly MenuItem[] => [
    { id: 'data', label: '打开数据', hint: 'F4', run: () => { onOpenData(openDataSql(table)) } },
    { id: 'insert', label: '插入名称', hint: 'Enter', run: () => { onInsert(table.name) } },
    { id: 'generate', label: '生成 SELECT', run: () => { onInsertSql?.(selectFromTableSql(table)) } },
    { id: 'columns', label: '添加全部列', run: () => { onInsertSql?.(columnListSql(table)) } },
    { id: 'overview', label: '表概览', run: () => { onOverview?.(table) } },
    { id: 'join', label: 'JOIN 另一张表…', run: () => { onJoin?.(table) } },
    { id: 'copy', label: '复制引用', run: () => { onCopy(qualifiedName(table)) } },
    { id: 'ddl', label: '查看 DDL', hint: 'Ctrl+B', run: () => { onShowDdl({ schema: table.schema ?? '', table: table.name, ...(table.kind === undefined ? {} : { kind: table.kind }) }) } },
    { id: 'refresh', label: '刷新表结构', run: onRefresh },
  ]

  const renderObject = (table: SchemaTable): ReactElement => {    const key = tableKey(table)
    const expanded = isOpen(key)
    return (
      <li key={key} className={styles.schemaItem}>
        <div
          className={styles.schemaRow}
          data-sql-schema-object={table.name}
          onContextMenu={event => {
            openMenu(event, qualifiedName(table), () => objectItems(table))
          }}
        >
          <button
            type="button"
            className={styles.schemaToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? '折叠' : '展开'} ${table.name}`}
            onClick={() => {
              toggle(key)
            }}
          >
            {expanded ? '▾' : '▸'}
          </button>
          <button
            type="button"
            className={styles.schemaName}
            style={tint.objectName}
            onClick={() => {
              onInsert(table.name)
            }}
            onDoubleClick={() => {
              onOpenData(openDataSql(table))
            }}
            title={`插入 ${table.name}（右键更多操作）`}
            onKeyDown={event => {
              // The menu's hint column promised F4 / Ctrl+B; make them real
              // (Enter already activates the button natively).
              if (event.key === 'F4') {
                event.preventDefault()
                onOpenData(openDataSql(table))
                return
              }
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
                event.preventDefault()
                onShowDdl({ schema: table.schema ?? '', table: table.name, ...(table.kind === undefined ? {} : { kind: table.kind }) })
              }
            }}
          >
            {table.name}
            <span className={styles.schemaCount}>{table.columns.length}</span>
          </button>
        </div>
        {expanded ? (
          <ul className={styles.schemaColumns}>
            {table.columns.length === 0 ? (
              <li className={styles.schemaEmpty} data-sql-empty-object="">
                无列信息{table.kind === 'view' ? '（视图）' : ''}
              </li>
            ) : null}
            {table.columns.map(column => (
              <li key={columnKey(table, column.name)}>
                <button
                  type="button"
                  className={styles.schemaColumn}
                  onClick={() => {
                    onInsert(column.name)
                  }}
                  onContextMenu={event => {
                    openMenu(event, column.name, () => [
                      { id: 'insert', label: '插入名称', run: () => { onInsert(column.name) } },
                      { id: 'copy', label: '复制列名', run: () => { onCopy(column.name) } },
                    ])
                  }}
                  title={`插入 ${column.name}（${column.type}；右键复制）`}
                >
                  <span className={styles.schemaColumnName} style={tint.columnName}>{column.name}</span>
                  <span className={styles.schemaColumnType} style={tint.columnType}>{column.type}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </li>
    )
  }

  const renderFolder = (schema: string, kind: 'table' | 'view', list: readonly SchemaTable[]): ReactElement => {
    const key = groupKey(schema, kind)
    const expanded = isOpen(key)
    return (
      <li key={key} className={styles.schemaItem}>
        <div className={styles.schemaRow}>
          <button
            type="button"
            className={styles.schemaToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? '折叠' : '展开'}${kind === 'view' ? '视图' : '表'}`}
            onClick={() => {
              toggle(key)
            }}
          >
            {expanded ? '▾' : '▸'}
          </button>
          <span className={styles.schemaFolder} style={tint.folder}>
            {kind === 'view' ? '视图' : '表'}
            <span className={styles.schemaCount}>{list.length}</span>
          </span>
        </div>
        {expanded ? <ul className={styles.schemaColumns}>{list.map(table => renderObject(table))}</ul> : null}
      </li>
    )
  }

  const renderSchema = (group: { readonly schema: string; readonly tables: readonly SchemaTable[]; readonly views: readonly SchemaTable[] }): ReactElement => {
    const key = schemaKey(group.schema)
    const expanded = isOpen(key)
    const total = group.tables.length + group.views.length
    return (
      <li key={key} className={styles.schemaItem}>
        <div
          className={styles.schemaRow}
          style={tint.schemaRow}
          data-sql-schema={group.schema}
          onContextMenu={event => {
            openMenu(event, group.schema, () => [
              { id: 'copy', label: '复制库名', run: () => { onCopy(group.schema) } },
              { id: 'refresh', label: '刷新表结构', run: onRefresh },
            ])
          }}
        >
          <button
            type="button"
            className={styles.schemaToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? '折叠' : '展开'} ${group.schema}`}
            onClick={() => {
              toggle(key)
            }}
          >
            {expanded ? '▾' : '▸'}
          </button>
          <span className={styles.schemaDatabase} style={tint.schemaName}>{group.schema}</span>
          <span className={styles.schemaCount}>{total}</span>
        </div>
        {expanded ? (
          <ul className={styles.schemaColumns}>
            {group.tables.length > 0 ? renderFolder(group.schema, 'table', group.tables) : null}
            {group.views.length > 0 ? renderFolder(group.schema, 'view', group.views) : null}
          </ul>
        ) : null}
      </li>
    )
  }

  const menuBox = menu === null ? null : menuPosition(
    { x: menu.x, y: menu.y },
    MENU_SIZE,
    { width: window.innerWidth, height: window.innerHeight },
  )

  return (
    <section className={styles.schemaTree} data-sql-schema-tree="" aria-label="数据库对象">
      <div className={styles.schemaTreeBar}>
        <input
          className={styles.schemaFilter}
          value={filter}
          placeholder="筛选库、表或字段"
          aria-label="筛选库、表或字段"
          onChange={event => {
            setFilter(event.target.value)
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setFilter('')
            }
          }}
        />
        {showRefresh ? (
          <button type="button" className={styles.button} onClick={onRefresh} disabled={loading} aria-label="刷新表结构">
            刷新
          </button>
        ) : null}
      </div>

      {connectionName === undefined ? null : (
        <p className={styles.schemaRoot} style={tint.root} data-sql-schema-root="">
          数据源 · {connectionName}
        </p>
      )}
      {loading ? <p className={styles.schemaNote}>正在读取表结构…</p> : null}
      {!loading && note !== undefined ? <p className={styles.schemaNote} data-sql-schema-note="">{note}</p> : null}
      {!loading && groups.length === 0 && note === undefined ? (
        <p className={styles.schemaNote}>这个连接下没有可见的表</p>
      ) : null}

      <ul className={styles.schemaList}>
        {groups.map(group => (named
          ? renderSchema(group)
          : (
            <React.Fragment key="flat">
              {group.tables.length > 0 ? renderFolder(group.schema, 'table', group.tables) : null}
              {group.views.length > 0 ? renderFolder(group.schema, 'view', group.views) : null}
            </React.Fragment>
          )))}
      </ul>

      {menu === null || menuBox === null ? null : (
        <div
          ref={menuRef}
          className={styles.schemaMenu}
          role="menu"
          data-sql-schema-menu=""
          aria-label={`${menu.title} 操作`}
          style={{ left: menuBox.left, top: menuBox.top }}
          onContextMenu={event => {
            event.preventDefault()
          }}
        >
          <p className={styles.schemaMenuTitle}>{menu.title}</p>
          {menu.items.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={styles.schemaMenuItem}
              data-sql-menu-item={item.id}
              onClick={() => {
                setMenu(null)
                item.run()
              }}
            >
              {item.label}
              {item.hint === undefined ? null : <span className={styles.schemaMenuHint}>{item.hint}</span>}
            </button>
          ))}
        </div>
      )}

    </section>
  )
}

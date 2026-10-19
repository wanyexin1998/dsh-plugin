/**
 * Schema-aware SQL completion — the pragmatic slice of DataGrip's N4.
 *
 * The reverse-engineering pass rated PSI-grade completion out of MVP scope
 * (docs/01 N4: "评估 #14 很高难度"), with "语法高亮 + 历史补全" as the fallback.
 * This module delivers the useful half of that promise without a parser: it
 * reads the identifiers around the caret, decides whether the position wants a
 * table or a column, and filters the connection's schema down to what matches.
 *
 * Deliberately not a parser: no scope resolution, no CTE analysis, no type
 * inference. It is a token-and-keyword heuristic on purpose — cheap, testable,
 * and honest about being a suggestion rather than an authority.
 */

/** One column of one table, as `information_schema` reports it. */
export interface SchemaColumn {
  readonly name: string
  readonly type: string
}

export interface SchemaTable {
  readonly name: string
  readonly columns: readonly SchemaColumn[]
  /**
   * Database/schema the table lives in.
   *
   * Absent on older snapshots and on the SHOW fallback of a connection that
   * names its database — the tree then renders the single implicit namespace.
   */
  readonly schema?: string
  /**
   * `table` or `view`.
   *
   * DataGrip splits a schema into Tables and Views folders; we keep the same
   * grouping. Absent when the catalogue could not tell us (SHOW fallback).
   */
  readonly kind?: 'table' | 'view'
}

/**
 * What completion may suggest for one connection.
 *
 * The suggestion engine itself is CodeMirror's `@codemirror/lang-sql` now (see
 * `editor-cm.ts`); this type stays because the schema reader, the object tree
 * and the panel all speak it.
 */
export interface SchemaIndex {
  readonly tables: readonly SchemaTable[]
}

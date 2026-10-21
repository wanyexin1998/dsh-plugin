/**
 * Ranking and live templates for SQL completion.
 *
 * CodeMirror's keyword list is **alphabetical**: type `S` and the popup fills
 * with `SAVEPOINT`, `SCHEMA`, `SCHEMA_NAME`, `SCHEDULE`, `SCROLL`… while
 * `SELECT` — the word people actually type — sits below the fold. The list is
 * correct, the order is useless.
 *
 * Two cheap fixes, no parser required:
 *   1. a **boost table** so everyday keywords outrank alphabet neighbours
 *      (`Completion.boost` is added to the match score, so it decides order);
 *   2. **live templates** (`sel`, `selw`, `ins`, …) that expand to a skeleton,
 *      which is how DataGrip users actually start a query.
 *
 * Everything here is pure so it is testable without an editor.
 */

/**
 * Boost per keyword, keyed in upper case.
 *
 * Only words that pay rent belong here: clause starters, the join family, the
 * aggregates people reach for. Absent means 0, which keeps the alphabetical
 * order among the rest (nothing is hidden, only re-ordered).
 */
export const KEYWORD_BOOSTS: Readonly<Record<string, number>> = {
  SELECT: 12,
  FROM: 11,
  WHERE: 10,
  JOIN: 9,
  LEFT: 8,
  RIGHT: 7,
  INNER: 7,
  OUTER: 6,
  GROUP: 9,
  ORDER: 9,
  BY: 9,
  HAVING: 8,
  LIMIT: 8,
  OFFSET: 6,
  ON: 8,
  AS: 7,
  AND: 7,
  OR: 6,
  NOT: 6,
  IN: 7,
  IS: 7,
  NULL: 7,
  DISTINCT: 8,
  UNION: 7,
  ALL: 4,
  INSERT: 9,
  INTO: 9,
  VALUES: 9,
  UPDATE: 9,
  SET: 9,
  DELETE: 9,
  CREATE: 6,
  DROP: 5,
  ALTER: 5,
  TABLE: 5,
  VIEW: 5,
  SHOW: 7,
  DESC: 6,
  EXPLAIN: 6,
  WITH: 8,
  LIKE: 7,
  BETWEEN: 6,
  EXISTS: 6,
  CASE: 7,
  WHEN: 7,
  THEN: 7,
  ELSE: 6,
  END: 7,
  OVER: 7,
  PARTITION: 5,
  COUNT: 8,
  SUM: 7,
  AVG: 7,
  MIN: 6,
  MAX: 6,
}

/** Boost for one keyword; unknown words add nothing. */
export function keywordBoost(label: string): number {
  return KEYWORD_BOOSTS[label.toUpperCase()] ?? 0
}

/** One expandable skeleton. */
export interface Template {
  /** What the user types. */
  readonly label: string
  /** Snippet body; `${}` marks the cursor stops. */
  readonly snippet: string
  /** Shown on the right of the popup row. */
  readonly detail: string
}

/**
 * The templates worth memorising.
 *
 * Names follow DataGrip's `sel` / `selw` / `ins` conventions where they overlap,
 * so muscle memory carries over. Snippets are one line unless the shape really
 * needs two.
 */
export const TEMPLATES: readonly Template[] = [
  { label: 'sel', snippet: 'SELECT * FROM ${} ', detail: '查全表' },
  { label: 'selc', snippet: 'SELECT COUNT(*) FROM ${} ', detail: '计数' },
  { label: 'selw', snippet: 'SELECT *\nFROM ${}\nWHERE ${}', detail: '查全表 + 条件' },
  { label: 'selagg', snippet: 'SELECT ${}, COUNT(*)\nFROM ${}\nGROUP BY ${}', detail: '分组聚合' },
  { label: 'ins', snippet: 'INSERT INTO ${} (${})\nVALUES (${})', detail: '插入' },
  { label: 'upd', snippet: 'UPDATE ${}\nSET ${}\nWHERE ${}', detail: '更新' },
  { label: 'del', snippet: 'DELETE FROM ${}\nWHERE ${}', detail: '删除' },
  { label: 'jo', snippet: 'JOIN ${} ON ${}', detail: '内连接' },
  { label: 'lj', snippet: 'LEFT JOIN ${} ON ${}', detail: '左连接' },
  { label: 'gb', snippet: 'GROUP BY ${}', detail: '分组' },
  { label: 'ob', snippet: 'ORDER BY ${} DESC', detail: '排序' },
  { label: 'lim', snippet: 'LIMIT ${}', detail: '限制行数' },
]

/**
 * Templates whose label starts with `prefix`.
 *
 * A one-letter prefix returns everything, which would flood the popup ahead of
 * keywords — so templates only surface from **two** characters on.
 */
export function matchingTemplates(prefix: string): readonly Template[] {
  const lower = prefix.toLowerCase()
  if (lower.length < 2) return []
  return TEMPLATES.filter(template => template.label.startsWith(lower))
}

/**
 * Line-level SQL diff for agent proposals (SQL-406).
 *
 * The diff is deliberately line-based: an agent rewrite of a SQL script is
 * reviewed line by line, and a character diff would light up entire lines for a
 * one-word change. Ordering is "delete before add" inside a replaced region so a
 * reviewer reads the old line first, then the new one.
 *
 * Every function here is pure: the panel owns the proposal state, the component
 * only renders it, and accepting simply applies the proposed text.
 */

/** One line's role in the diff. */
export type DiffLineType = 'same' | 'add' | 'del'

/** One diff row: the line text is kept verbatim, whitespace included. */
export interface DiffLine {
  readonly type: DiffLineType
  readonly text: string
}

/** Counts shown beside the proposal title. */
export interface DiffSummary {
  readonly added: number
  readonly removed: number
  readonly unchanged: number
}

/**
 * Split a SQL text into lines.
 *
 * An empty text is zero lines. A trailing newline becomes a final empty line, so
 * joining the result with `\n` reproduces the input exactly.
 *
 * @param text - SQL source.
 * @returns one entry per line, without separators.
 */
function toLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

/**
 * Diff two SQL texts line by line with a longest-common-subsequence walk.
 *
 * @param original - SQL currently in the editor.
 * @param proposal - SQL the agent proposes.
 * @returns the ordered diff rows; identical texts yield only `same` rows.
 */
export function diffLines(original: string, proposal: string): DiffLine[] {
  const left = toLines(original)
  const right = toLines(proposal)
  const columns = right.length + 1

  // table[row][column] is the LCS length of left[row..] against right[column..].
  const table: Uint32Array[] = []
  for (let row = 0; row <= left.length; row += 1) table.push(new Uint32Array(columns))
  for (let row = left.length - 1; row >= 0; row -= 1) {
    const current = table[row]!
    const next = table[row + 1]!
    for (let column = right.length - 1; column >= 0; column -= 1) {
      current[column] =
        left[row] === right[column]
          ? next[column + 1]! + 1
          : Math.max(next[column]!, current[column + 1]!)
    }
  }

  const lines: DiffLine[] = []
  let row = 0
  let column = 0
  while (row < left.length && column < right.length) {
    const text = left[row]!
    const other = right[column]!
    if (text === other) {
      lines.push({ type: 'same', text })
      row += 1
      column += 1
      continue
    }
    // On a tie the deletion wins, so a replaced pair reads old-then-new.
    if (table[row + 1]![column]! >= table[row]![column + 1]!) {
      lines.push({ type: 'del', text })
      row += 1
      continue
    }
    lines.push({ type: 'add', text: other })
    column += 1
  }
  while (row < left.length) {
    lines.push({ type: 'del', text: left[row]! })
    row += 1
  }
  while (column < right.length) {
    lines.push({ type: 'add', text: right[column]! })
    column += 1
  }
  return lines
}

/**
 * Count the rows of one diff.
 *
 * @param lines - rows produced by {@link diffLines}.
 * @returns added / removed / unchanged row counts.
 */
export function diffSummary(lines: readonly DiffLine[]): DiffSummary {
  let added = 0
  let removed = 0
  let unchanged = 0
  for (const line of lines) {
    if (line.type === 'add') added += 1
    else if (line.type === 'del') removed += 1
    else unchanged += 1
  }
  return { added, removed, unchanged }
}

/**
 * Reconstruct the proposed text from a diff.
 *
 * Accepting applies this result instead of the raw proposal string, which keeps
 * "what was shown" and "what was written back" derived from the same rows.
 *
 * @param lines - rows produced by {@link diffLines}.
 * @returns the proposal text, exactly as diffed.
 */
export function applyDiff(lines: readonly DiffLine[]): string {
  const kept: string[] = []
  for (const line of lines) {
    if (line.type !== 'del') kept.push(line.text)
  }
  return kept.join('\n')
}

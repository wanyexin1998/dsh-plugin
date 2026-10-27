/**
 * Prompts for the "pair with the agent" actions (SQL-405/406).
 *
 * The workbench does not own a chat surface, so the honest contract is: build a
 * complete, self-contained prompt, put it on the clipboard, and let the user
 * paste it into the conversation. That is also why both prompts are plain
 * functions — the exact wording is testable and reviewable.
 */

/** Common footer: ask for a short, reviewable answer. */
const ASK = '请用中文回答；先给结论，再给必要说明；不要编造我没有提供的表结构。'

/**
 * Prompt asking the agent to explain the statement.
 *
 * @param sql - The SQL under the caret.
 */
export function explainSqlPrompt(sql: string): string {
  return [
    '请解释下面这条 SQL：它做了什么、按什么顺序执行、结果大概是什么样。',
    '',
    '```sql',
    sql.trim(),
    '```',
    '',
    ASK,
  ].join('\n')
}

/**
 * Prompt asking the agent to diagnose a failed statement (SQL-310).
 *
 * @param error - The translated error shown next to the grid.
 * @param sql - The statement that failed, when known.
 */
export function errorSqlPrompt(error: { readonly code: string; readonly message: string }, sql?: string): string {
  const lines = [
    '下面这条 SQL 执行报错了，请帮我定位原因并给出修复后的 SQL。',
    '',
    `错误：${error.message}（${error.code}）`,
  ]
  if (sql !== undefined && sql.trim() !== '') {
    lines.push('', '```sql', sql.trim(), '```')
  }
  lines.push('', ASK)
  return lines.join('\n')
}

/**
 * Prompt asking the agent to review/optimise the statement.
 *
 * @param sql - The SQL under the caret.
 */
export function optimizeSqlPrompt(sql: string): string {
  return [
    '请审查下面这条 SQL 的正确性与性能，并给出可直接替换的改写版本：',
    '- 指出可能的性能问题（扫描、连接顺序、函数包列、隐式转换等）；',
    '- 如果改写有风险（结果语义变化），明确说明；',
    '- 最后给出改写后的完整 SQL。',
    '',
    '```sql',
    sql.trim(),
    '```',
    '',
    ASK,
  ].join('\n')
}

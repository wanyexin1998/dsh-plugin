/**
 * Turn a driver refusal into something a person can act on.
 *
 * Doris/MySQL errors arrive as one long string, e.g.
 *
 *   INTERNAL: errCode = 2, detailMessage = SHOW CREATE TABLE command denied to
 *   user 'ai_reader'@'172.26.200.108' for table 'dwd: dwd_trade_order_all_v'
 *
 * Dropped into a dialog verbatim that reads like a crash. The message itself is
 * accurate — the account simply lacks `SHOW VIEW` on that object — so the job
 * here is to keep the facts and say what to do about them, not to invent a
 * cause.
 */

/** The shape the panel gets back when a statement is refused. */
export interface DbFailure {
  readonly code?: string
  readonly message: string
}

/** Strip the `INTERNAL: errCode = 2, detailMessage = ` wrapper Doris adds. */
export function detailOf(raw: string): string {
  const marker = 'detailMessage = '
  const at = raw.indexOf(marker)
  return (at === -1 ? raw : raw.slice(at + marker.length)).trim()
}

/** `dwd: dwd_trade_order_all_v` (Doris) → `dwd.dwd_trade_order_all_v`. */
function qualifiedName(raw: string): string {
  const match = /^([^:]+):\s*(.+)$/.exec(raw)
  // Both groups are mandatory in the pattern, so no fallbacks are needed.
  return match === null ? raw.trim() : `${String(match[1]).trim()}.${String(match[2]).trim()}`
}

/**
 * Readable text for a failed statement.
 *
 * Falls back to the driver's own words (without the wrapper) when the shape is
 * not one of the known ones — a wrong-but-specific message beats a generic one.
 */
export function readableDbError(failure: DbFailure): string {
  const detail = detailOf(failure.message ?? '')

  const denied = /command denied to user '([^']+)'@'[^']*' for (?:table|view) '([^']+)'/i.exec(detail)
  if (denied !== null) {
    // The regex guarantees both groups, so `String()` is exact, not a coercion.
    const user = String(denied[1])
    const object = qualifiedName(String(denied[2]))
    return `没有查看 ${object} 的权限：账号 ${user} 缺少 SHOW VIEW（或该对象对它不可见）。可以右键「打开数据」先看内容，或请 DBA 授予该对象的查看权限。`
  }

  if (/access denied for user/i.test(detail)) {
    return `数据库拒绝登录：${detail}。检查连接里的账号与密码。`
  }

  if (/unknown (table|database)|doesn't exist|not found/i.test(detail)) {
    return `对象不存在或已被删除（${detail}）。刷新表结构后再试。`
  }

  if (/syntax error/i.test(detail)) {
    return `数据库报语法错误：${detail}`
  }

  return detail === '' ? (failure.code ?? '数据库返回了空错误') : detail
}

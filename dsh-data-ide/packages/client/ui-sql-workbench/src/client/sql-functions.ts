/**
 * The SQL function catalogue behind function completion, hover and the
 * formatter's "is this a call or a clause?" spacing decision.
 *
 * Data, not logic: one record per function (name, signature, category, a short
 * Chinese description) plus the three lookups callers actually need. Keeping it
 * a plain array makes it reviewable, testable and cheap to extend — a missing
 * entry costs a completion suggestion, never correctness.
 *
 * Scope is MySQL 5.7/8.0 plus Doris, because those are the two servers this
 * plugin talks to (docs/04). Signatures use argument *names* rather than types
 * so the same string serves the popup detail line and the snippet template.
 */

/** Grouping used by completion ranking and the hover card. */
export type SqlFunctionCategory =
  | 'aggregate'
  | 'window'
  | 'string'
  | 'date'
  | 'numeric'
  | 'conditional'
  | 'conversion'
  | 'json'
  | 'system'

export interface SqlFunction {
  /** Upper-case canonical name. */
  readonly name: string
  /** Argument names as written, e.g. `DATE_FORMAT(date, format)`. */
  readonly signature: string
  readonly category: SqlFunctionCategory
  /** One-line Chinese description shown next to the signature. */
  readonly detail: string
  /**
   * Explicit snippet when the derived one would be wrong.
   *
   * `CAST(x AS type)` has no comma, so splitting the argument list on commas
   * would produce one broken placeholder; it declares its snippet instead.
   */
  readonly snippet?: string
}

/**
 * Every function offered by completion.
 *
 * Ordered by category so the popup has a stable, human order rather than the
 * alphabet: aggregates first (most typed), then window, string, date, numeric,
 * conditional, conversion, JSON and system.
 */
export const SQL_FUNCTIONS: readonly SqlFunction[] = [
  // Aggregates.
  { name: 'COUNT', signature: 'COUNT(expr)', category: 'aggregate', detail: '计数' },
  { name: 'SUM', signature: 'SUM(expr)', category: 'aggregate', detail: '求和' },
  { name: 'AVG', signature: 'AVG(expr)', category: 'aggregate', detail: '平均值' },
  { name: 'MIN', signature: 'MIN(expr)', category: 'aggregate', detail: '最小值' },
  { name: 'MAX', signature: 'MAX(expr)', category: 'aggregate', detail: '最大值' },
  { name: 'GROUP_CONCAT', signature: 'GROUP_CONCAT(expr)', category: 'aggregate', detail: '拼接分组内取值' },
  { name: 'STDDEV', signature: 'STDDEV(expr)', category: 'aggregate', detail: '标准差' },
  { name: 'STDDEV_POP', signature: 'STDDEV_POP(expr)', category: 'aggregate', detail: '总体标准差' },
  { name: 'STDDEV_SAMP', signature: 'STDDEV_SAMP(expr)', category: 'aggregate', detail: '样本标准差' },
  { name: 'VARIANCE', signature: 'VARIANCE(expr)', category: 'aggregate', detail: '方差' },
  { name: 'VAR_POP', signature: 'VAR_POP(expr)', category: 'aggregate', detail: '总体方差' },
  { name: 'VAR_SAMP', signature: 'VAR_SAMP(expr)', category: 'aggregate', detail: '样本方差' },
  { name: 'APPROX_COUNT_DISTINCT', signature: 'APPROX_COUNT_DISTINCT(expr)', category: 'aggregate', detail: '近似去重计数' },
  { name: 'BIT_AND', signature: 'BIT_AND(expr)', category: 'aggregate', detail: '按位与聚合' },
  { name: 'BIT_OR', signature: 'BIT_OR(expr)', category: 'aggregate', detail: '按位或聚合' },
  { name: 'BIT_XOR', signature: 'BIT_XOR(expr)', category: 'aggregate', detail: '按位异或聚合' },
  { name: 'MEDIAN', signature: 'MEDIAN(expr)', category: 'aggregate', detail: '中位数' },

  // Window functions (all need an OVER clause).
  { name: 'ROW_NUMBER', signature: 'ROW_NUMBER()', category: 'window', detail: '窗口行号' },
  { name: 'RANK', signature: 'RANK()', category: 'window', detail: '排名（并列跳号）' },
  { name: 'DENSE_RANK', signature: 'DENSE_RANK()', category: 'window', detail: '排名（并列不跳号）' },
  { name: 'LAG', signature: 'LAG(expr, offset)', category: 'window', detail: '取前 N 行' },
  { name: 'LEAD', signature: 'LEAD(expr, offset)', category: 'window', detail: '取后 N 行' },
  { name: 'FIRST_VALUE', signature: 'FIRST_VALUE(expr)', category: 'window', detail: '窗口首值' },
  { name: 'LAST_VALUE', signature: 'LAST_VALUE(expr)', category: 'window', detail: '窗口末值' },
  { name: 'NTH_VALUE', signature: 'NTH_VALUE(expr, n)', category: 'window', detail: '窗口第 N 个值' },
  { name: 'NTILE', signature: 'NTILE(buckets)', category: 'window', detail: '分桶编号' },
  { name: 'CUME_DIST', signature: 'CUME_DIST()', category: 'window', detail: '累积分布' },
  { name: 'PERCENT_RANK', signature: 'PERCENT_RANK()', category: 'window', detail: '百分比排名' },

  // Strings.
  { name: 'CONCAT', signature: 'CONCAT(str1, str2)', category: 'string', detail: '拼接字符串' },
  { name: 'CONCAT_WS', signature: 'CONCAT_WS(sep, str1, str2)', category: 'string', detail: '带分隔符拼接' },
  { name: 'SUBSTR', signature: 'SUBSTR(str, pos)', category: 'string', detail: '取子串' },
  { name: 'SUBSTRING', signature: 'SUBSTRING(str, pos)', category: 'string', detail: '取子串' },
  { name: 'LEFT', signature: 'LEFT(str, len)', category: 'string', detail: '左侧 N 个字符' },
  { name: 'RIGHT', signature: 'RIGHT(str, len)', category: 'string', detail: '右侧 N 个字符' },
  { name: 'LENGTH', signature: 'LENGTH(str)', category: 'string', detail: '字节长度' },
  { name: 'CHAR_LENGTH', signature: 'CHAR_LENGTH(str)', category: 'string', detail: '字符长度' },
  { name: 'UPPER', signature: 'UPPER(str)', category: 'string', detail: '转大写' },
  { name: 'LOWER', signature: 'LOWER(str)', category: 'string', detail: '转小写' },
  { name: 'TRIM', signature: 'TRIM(str)', category: 'string', detail: '去两端空白' },
  { name: 'LTRIM', signature: 'LTRIM(str)', category: 'string', detail: '去左空白' },
  { name: 'RTRIM', signature: 'RTRIM(str)', category: 'string', detail: '去右空白' },
  { name: 'REPLACE', signature: 'REPLACE(str, from, to)', category: 'string', detail: '替换子串' },
  { name: 'LPAD', signature: 'LPAD(str, len, pad)', category: 'string', detail: '左侧补齐' },
  { name: 'RPAD', signature: 'RPAD(str, len, pad)', category: 'string', detail: '右侧补齐' },
  { name: 'INSTR', signature: 'INSTR(str, sub)', category: 'string', detail: '子串位置' },
  { name: 'LOCATE', signature: 'LOCATE(sub, str)', category: 'string', detail: '子串位置' },
  { name: 'REVERSE', signature: 'REVERSE(str)', category: 'string', detail: '反转字符串' },
  { name: 'REPEAT', signature: 'REPEAT(str, n)', category: 'string', detail: '重复字符串' },
  { name: 'ASCII', signature: 'ASCII(str)', category: 'string', detail: '首字符 ASCII 码' },
  { name: 'HEX', signature: 'HEX(n)', category: 'string', detail: '转十六进制' },
  { name: 'UNHEX', signature: 'UNHEX(hex)', category: 'string', detail: '十六进制转字符串' },
  { name: 'MD5', signature: 'MD5(str)', category: 'string', detail: 'MD5 摘要' },
  { name: 'SHA1', signature: 'SHA1(str)', category: 'string', detail: 'SHA1 摘要' },
  { name: 'SHA2', signature: 'SHA2(str, bits)', category: 'string', detail: 'SHA2 摘要' },
  { name: 'REGEXP_REPLACE', signature: 'REGEXP_REPLACE(str, pat, repl)', category: 'string', detail: '正则替换' },
  { name: 'REGEXP_EXTRACT', signature: 'REGEXP_EXTRACT(str, pat)', category: 'string', detail: '正则提取' },
  { name: 'SPLIT_PART', signature: 'SPLIT_PART(str, delim, n)', category: 'string', detail: '按分隔符取第 N 段' },
  { name: 'FIND_IN_SET', signature: 'FIND_IN_SET(str, list)', category: 'string', detail: '在逗号列表中查找' },
  { name: 'FORMAT', signature: 'FORMAT(x, decimals)', category: 'string', detail: '数字千分位格式化' },
  { name: 'SPACE', signature: 'SPACE(n)', category: 'string', detail: '生成 N 个空格' },
  { name: 'BIN', signature: 'BIN(n)', category: 'string', detail: '转二进制字符串' },

  // Dates.
  { name: 'NOW', signature: 'NOW()', category: 'date', detail: '当前时间' },
  { name: 'CURDATE', signature: 'CURDATE()', category: 'date', detail: '当前日期' },
  { name: 'CURTIME', signature: 'CURTIME()', category: 'date', detail: '当前时间' },
  { name: 'UTC_TIMESTAMP', signature: 'UTC_TIMESTAMP()', category: 'date', detail: 'UTC 当前时间' },
  { name: 'DATE_FORMAT', signature: 'DATE_FORMAT(date, format)', category: 'date', detail: '日期格式化' },
  { name: 'STR_TO_DATE', signature: 'STR_TO_DATE(str, format)', category: 'date', detail: '字符串转日期' },
  { name: 'DATE_ADD', signature: 'DATE_ADD(date, interval)', category: 'date', detail: '日期加' },
  { name: 'DATE_SUB', signature: 'DATE_SUB(date, interval)', category: 'date', detail: '日期减' },
  { name: 'ADDDATE', signature: 'ADDDATE(date, days)', category: 'date', detail: '日期加天数' },
  { name: 'SUBDATE', signature: 'SUBDATE(date, days)', category: 'date', detail: '日期减天数' },
  { name: 'DATEDIFF', signature: 'DATEDIFF(a, b)', category: 'date', detail: '相差天数' },
  { name: 'TIMESTAMPDIFF', signature: 'TIMESTAMPDIFF(unit, a, b)', category: 'date', detail: '相差时间' },
  { name: 'TIMESTAMPADD', signature: 'TIMESTAMPADD(unit, n, date)', category: 'date', detail: '时间加' },
  { name: 'DATE', signature: 'DATE(expr)', category: 'date', detail: '取日期部分' },
  { name: 'TIME', signature: 'TIME(expr)', category: 'date', detail: '取时间部分' },
  { name: 'YEAR', signature: 'YEAR(date)', category: 'date', detail: '取年' },
  { name: 'MONTH', signature: 'MONTH(date)', category: 'date', detail: '取月' },
  { name: 'DAY', signature: 'DAY(date)', category: 'date', detail: '取日' },
  { name: 'HOUR', signature: 'HOUR(time)', category: 'date', detail: '取小时' },
  { name: 'MINUTE', signature: 'MINUTE(time)', category: 'date', detail: '取分钟' },
  { name: 'SECOND', signature: 'SECOND(time)', category: 'date', detail: '取秒' },
  { name: 'DAYOFWEEK', signature: 'DAYOFWEEK(date)', category: 'date', detail: '星期几（1=周日）' },
  { name: 'DAYOFYEAR', signature: 'DAYOFYEAR(date)', category: 'date', detail: '一年中第几天' },
  { name: 'DAYNAME', signature: 'DAYNAME(date)', category: 'date', detail: '星期名称' },
  { name: 'MONTHNAME', signature: 'MONTHNAME(date)', category: 'date', detail: '月份名称' },
  { name: 'WEEK', signature: 'WEEK(date)', category: 'date', detail: '一年中第几周' },
  { name: 'QUARTER', signature: 'QUARTER(date)', category: 'date', detail: '季度' },
  { name: 'LAST_DAY', signature: 'LAST_DAY(date)', category: 'date', detail: '当月最后一天' },
  { name: 'UNIX_TIMESTAMP', signature: 'UNIX_TIMESTAMP(date)', category: 'date', detail: '转 Unix 时间戳' },
  { name: 'FROM_UNIXTIME', signature: 'FROM_UNIXTIME(ts)', category: 'date', detail: 'Unix 时间戳转日期' },
  { name: 'EXTRACT', signature: 'EXTRACT(unit, date)', category: 'date', detail: '提取日期部分' },
  { name: 'DATE_TRUNC', signature: 'DATE_TRUNC(unit, date)', category: 'date', detail: '截断到指定精度' },
  { name: 'TO_DATE', signature: 'TO_DATE(str, format)', category: 'date', detail: '字符串转日期' },

  // Numbers.
  { name: 'ABS', signature: 'ABS(x)', category: 'numeric', detail: '绝对值' },
  { name: 'CEIL', signature: 'CEIL(x)', category: 'numeric', detail: '向上取整' },
  { name: 'CEILING', signature: 'CEILING(x)', category: 'numeric', detail: '向上取整' },
  { name: 'FLOOR', signature: 'FLOOR(x)', category: 'numeric', detail: '向下取整' },
  { name: 'ROUND', signature: 'ROUND(x, d)', category: 'numeric', detail: '四舍五入' },
  { name: 'TRUNCATE', signature: 'TRUNCATE(x, d)', category: 'numeric', detail: '截断小数' },
  { name: 'MOD', signature: 'MOD(a, b)', category: 'numeric', detail: '取余' },
  { name: 'POW', signature: 'POW(x, y)', category: 'numeric', detail: '幂' },
  { name: 'POWER', signature: 'POWER(x, y)', category: 'numeric', detail: '幂' },
  { name: 'SQRT', signature: 'SQRT(x)', category: 'numeric', detail: '平方根' },
  { name: 'EXP', signature: 'EXP(x)', category: 'numeric', detail: '自然指数' },
  { name: 'LN', signature: 'LN(x)', category: 'numeric', detail: '自然对数' },
  { name: 'LOG', signature: 'LOG(x)', category: 'numeric', detail: '对数' },
  { name: 'LOG2', signature: 'LOG2(x)', category: 'numeric', detail: '以 2 为底对数' },
  { name: 'LOG10', signature: 'LOG10(x)', category: 'numeric', detail: '以 10 为底对数' },
  { name: 'RAND', signature: 'RAND()', category: 'numeric', detail: '随机数' },
  { name: 'SIGN', signature: 'SIGN(x)', category: 'numeric', detail: '符号' },
  { name: 'GREATEST', signature: 'GREATEST(a, b)', category: 'numeric', detail: '取最大值' },
  { name: 'LEAST', signature: 'LEAST(a, b)', category: 'numeric', detail: '取最小值' },
  { name: 'PI', signature: 'PI()', category: 'numeric', detail: '圆周率' },
  { name: 'SIN', signature: 'SIN(x)', category: 'numeric', detail: '正弦' },
  { name: 'COS', signature: 'COS(x)', category: 'numeric', detail: '余弦' },
  { name: 'TAN', signature: 'TAN(x)', category: 'numeric', detail: '正切' },
  { name: 'DEGREES', signature: 'DEGREES(x)', category: 'numeric', detail: '弧度转角度' },
  { name: 'RADIANS', signature: 'RADIANS(x)', category: 'numeric', detail: '角度转弧度' },

  // Conditional expressions.
  { name: 'IFNULL', signature: 'IFNULL(a, b)', category: 'conditional', detail: '空值回退' },
  { name: 'NULLIF', signature: 'NULLIF(a, b)', category: 'conditional', detail: '相等则返回空' },
  { name: 'IF', signature: 'IF(cond, a, b)', category: 'conditional', detail: '条件表达式' },
  { name: 'COALESCE', signature: 'COALESCE(v1, v2)', category: 'conditional', detail: '取第一个非空值' },
  { name: 'ISNULL', signature: 'ISNULL(x)', category: 'conditional', detail: '是否为空' },

  // Conversions.
  { name: 'CAST', signature: 'CAST(x AS type)', category: 'conversion', detail: '类型转换', snippet: 'CAST(${x} AS ${type})' },
  { name: 'CONVERT', signature: 'CONVERT(x, type)', category: 'conversion', detail: '类型转换' },
  { name: 'BINARY', signature: 'BINARY(str)', category: 'conversion', detail: '转二进制字符串' },

  // JSON.
  { name: 'JSON_EXTRACT', signature: 'JSON_EXTRACT(json, path)', category: 'json', detail: '取 JSON 字段' },
  { name: 'JSON_UNQUOTE', signature: 'JSON_UNQUOTE(json)', category: 'json', detail: '去掉 JSON 引号' },
  { name: 'JSON_OBJECT', signature: 'JSON_OBJECT(key, value)', category: 'json', detail: '构造 JSON 对象' },
  { name: 'JSON_ARRAY', signature: 'JSON_ARRAY(value)', category: 'json', detail: '构造 JSON 数组' },
  { name: 'JSON_CONTAINS', signature: 'JSON_CONTAINS(json, value)', category: 'json', detail: 'JSON 是否包含' },
  { name: 'JSON_LENGTH', signature: 'JSON_LENGTH(json)', category: 'json', detail: 'JSON 长度' },
  { name: 'GET_JSON_OBJECT', signature: 'GET_JSON_OBJECT(json, path)', category: 'json', detail: '取 JSON 字段' },
  { name: 'JSON_TYPE', signature: 'JSON_TYPE(json)', category: 'json', detail: 'JSON 类型' },

  // Server information.
  { name: 'DATABASE', signature: 'DATABASE()', category: 'system', detail: '当前库名' },
  { name: 'USER', signature: 'USER()', category: 'system', detail: '当前用户' },
  { name: 'CURRENT_USER', signature: 'CURRENT_USER()', category: 'system', detail: '当前认证用户' },
  { name: 'VERSION', signature: 'VERSION()', category: 'system', detail: '服务端版本' },
  { name: 'UUID', signature: 'UUID()', category: 'system', detail: '随机 UUID' },
  { name: 'CONNECTION_ID', signature: 'CONNECTION_ID()', category: 'system', detail: '当前连接 ID' },
]

const BY_NAME: ReadonlyMap<string, SqlFunction> = new Map(
  SQL_FUNCTIONS.map(fn => [fn.name.toUpperCase(), fn]),
)

/** True when `name` is a function in the catalogue (case-insensitive). */
export function isSqlFunction(name: string): boolean {
  return BY_NAME.has(name.toUpperCase())
}

/** The catalogue entry for `name`, or `undefined` when it is not a function. */
export function findSqlFunction(name: string): SqlFunction | undefined {
  return BY_NAME.get(name.toUpperCase())
}

/**
 * Functions whose name starts with `prefix`, for the completion popup.
 *
 * @param prefix - What the user typed so far; empty returns the whole catalogue.
 * @param limit - Ceiling on returned entries (the popup renders 40 at most).
 */
export function matchSqlFunctions(prefix: string, limit = 200): readonly SqlFunction[] {
  const upper = prefix.toUpperCase()
  const matched = upper === '' ? SQL_FUNCTIONS : SQL_FUNCTIONS.filter(fn => fn.name.startsWith(upper))
  return matched.slice(0, Math.max(0, limit))
}

/**
 * Snippet body for one function: each argument becomes a named tab stop.
 *
 * `ROUND(x, d)` → `ROUND(${x}, ${d})`, so Tab walks the argument list the way
 * the live templates (`sel`, `ins`, …) do.
 */
export function functionSnippet(fn: SqlFunction): string {
  if (fn.snippet !== undefined) return fn.snippet
  const open = fn.signature.indexOf('(')
  // A no-argument call (`NOW()`) needs no placeholders at all.
  if (open === -1 || fn.signature.endsWith('()')) return fn.signature
  const args = fn.signature.slice(open + 1, -1)
  const placeholders = args.split(',').map(arg => `\${${arg.trim()}}`)
  return `${fn.signature.slice(0, open + 1)}${placeholders.join(', ')})`
}

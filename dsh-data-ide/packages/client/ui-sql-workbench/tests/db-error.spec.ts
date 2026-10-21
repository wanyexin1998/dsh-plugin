import { describe, expect, it } from 'vitest'

import { detailOf, readableDbError } from '../src/client/db-error.ts'

/** The exact string Doris returned for a denied `SHOW CREATE VIEW`. */
const DENIED = "INTERNAL: errCode = 2, detailMessage = SHOW CREATE TABLE command denied to user 'ai_reader'@'172.26.200.108' for table 'dwd: dwd_trade_order_all_v'"

describe('detailOf', () => {
  it('strips the Doris wrapper', () => {
    expect(detailOf(DENIED)).toBe("SHOW CREATE TABLE command denied to user 'ai_reader'@'172.26.200.108' for table 'dwd: dwd_trade_order_all_v'")
  })

  it('leaves a plain message alone', () => {
    expect(detailOf('没有 SHOW 权限')).toBe('没有 SHOW 权限')
  })
})

describe('readableDbError', () => {
  it('explains a denied SHOW VIEW and names the object and account', () => {
    const text = readableDbError({ code: 'INTERNAL', message: DENIED })

    expect(text).toContain('没有查看 dwd.dwd_trade_order_all_v 的权限')
    expect(text).toContain('ai_reader')
    expect(text).toContain('SHOW VIEW')
    // It offers a next step instead of stopping at the error.
    expect(text).toContain('打开数据')
    expect(text).not.toContain('errCode')
  })

  it('keeps a bare table name as it is when there is no schema part', () => {
    const text = readableDbError({ message: "command denied to user 'ai_reader'@'10.0.0.1' for table 'plain_table'" })
    expect(text).toContain('没有查看 plain_table 的权限')
  })

  it('explains a syntax error without hiding the driver text', () => {
    expect(readableDbError({ message: 'errCode = 2, detailMessage = Syntax error in line 2' })).toBe('数据库报语法错误：Syntax error in line 2')
  })

  it('survives a missing message', () => {
    expect(readableDbError({ code: 'UNKNOWN', message: undefined as unknown as string })).toBe('UNKNOWN')
  })

  it('explains a refused login', () => {
    expect(readableDbError({ message: "Access denied for user 'ai_reader'@'10.0.0.1' (using password: YES)" }))
      .toContain('检查连接里的账号与密码')
  })

  it('explains a vanished object', () => {
    expect(readableDbError({ message: "Table 'dwd.gone' doesn't exist" })).toContain('刷新表结构后再试')
  })

  it('keeps the driver words when it does not recognise the shape', () => {
    expect(readableDbError({ message: 'INTERNAL: errCode = 2, detailMessage = something odd' })).toBe('something odd')
    expect(readableDbError({ message: 'plain failure' })).toBe('plain failure')
  })

  it('falls back to the code when the message is empty', () => {
    expect(readableDbError({ code: 'TIMEOUT', message: '' })).toBe('TIMEOUT')
    expect(readableDbError({ message: '' })).toBe('数据库返回了空错误')
  })
})

import { describe, expect, it } from 'vitest'

import { parseTableTitle } from '../src/client/result-tabs.ts'

describe('parseTableTitle', () => {
  it('names a simple select after its table', () => {
    expect(parseTableTitle('SELECT * FROM dwd_order')).toBe('dwd_order')
    expect(parseTableTitle('select id from dwd_order where id = 1')).toBe('dwd_order')
  })

  it('drops the schema prefix and unquotes backticked names', () => {
    expect(parseTableTitle('SELECT * FROM `dwd`.`dwd_order`')).toBe('dwd_order')
    expect(parseTableTitle('SELECT * FROM `we``ird`')).toBe('we`ird')
  })

  it('joins the first two FROM/JOIN targets', () => {
    expect(parseTableTitle('SELECT * FROM a JOIN b ON a.id = b.id')).toBe('a+b')
    expect(parseTableTitle('SELECT * FROM a LEFT JOIN b ON a.id = b.id JOIN c ON 1')).toBe('a+b')
  })

  it('returns null when there is no FROM/JOIN', () => {
    expect(parseTableTitle('SELECT 1')).toBeNull()
    expect(parseTableTitle('SHOW TABLES')).toBeNull()
  })
})

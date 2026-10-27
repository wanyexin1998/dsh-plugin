import { describe, expect, it } from 'vitest'

import { errorSqlPrompt, explainSqlPrompt, optimizeSqlPrompt } from '../src/client/agent-prompts.ts'

describe('agent prompts', () => {
  it('wraps the statement in a fenced explain request', () => {
    const prompt = explainSqlPrompt('  SELECT 1  ')
    expect(prompt).toContain('```sql\nSELECT 1\n```')
    expect(prompt).toContain('请解释下面这条 SQL')
    expect(prompt).toContain('请用中文回答')
  })

  it('includes the error and the failing SQL in the diagnose prompt', () => {
    const prompt = errorSqlPrompt({ code: 'SQL_SYNTAX', message: '语法错误' }, 'SELECT FROM')
    expect(prompt).toContain('执行报错了')
    expect(prompt).toContain('SQL_SYNTAX')
    expect(prompt).toContain('SELECT FROM')
  })

  it('omits the SQL fence when the failed statement is unknown', () => {
    const prompt = errorSqlPrompt({ code: 'X', message: '失败' })
    expect(prompt).not.toContain('```sql')
    expect(prompt).toContain('请用中文回答')
  })

  it('asks for an optimisation with explicit risk notes', () => {
    const prompt = optimizeSqlPrompt('SELECT * FROM t')
    expect(prompt).toContain('请审查下面这条 SQL')
    expect(prompt).toContain('性能问题')
    expect(prompt).toContain('完整 SQL')
    expect(prompt).toContain('SELECT * FROM t')
  })
})

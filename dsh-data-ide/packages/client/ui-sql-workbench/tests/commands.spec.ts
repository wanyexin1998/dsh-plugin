import { describe, expect, it, vi } from 'vitest'

import { type CommandAction, filterCommands } from '../src/client/commands.ts'

const actions: readonly CommandAction[] = [
  { id: 'run', title: '执行光标语句', keywords: 'run Ctrl+Enter', run: vi.fn() },
  { id: 'format', title: '格式化 SQL', keywords: 'format Ctrl+Alt+L', run: vi.fn() },
  { id: 'history', title: '查询历史与收藏', keywords: 'history', run: vi.fn() },
]

describe('filterCommands', () => {
  it('returns everything for an empty query', () => {
    expect(filterCommands(actions, '')).toBe(actions)
    expect(filterCommands(actions, '   ')).toBe(actions)
  })

  it('matches every word against title or keywords', () => {
    expect(filterCommands(actions, '格式')).toEqual([actions[1]])
    expect(filterCommands(actions, 'sql format')).toEqual([actions[1]])
    expect(filterCommands(actions, 'ctrl+enter')).toEqual([actions[0]])
    expect(filterCommands(actions, 'zzz')).toEqual([])
  })

  it('ranks title-prefix matches before other contains matches', () => {
    const many: readonly CommandAction[] = [
      { id: 'a', title: '重跑上次', keywords: '执行', run: vi.fn() },
      { id: 'b', title: '执行全部', keywords: '', run: vi.fn() },
      { id: 'c', title: '执行说明', run: vi.fn() },
    ]
    expect(filterCommands(many, '执行').map(action => action.id)).toEqual(['b', 'c', 'a'])
  })
})

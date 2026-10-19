import { describe, expect, it } from 'vitest'

import { createMemoryKvStore } from '../src/host/kv.ts'

describe('memory key/value store', () => {
  it('seeds from a plain object', async () => {
    const store = createMemoryKvStore({ active: 'ds-1' })

    expect(await store.get('active')).toBe('ds-1')
    expect(await store.entries()).toEqual([{ key: 'active', value: 'ds-1' }])
  })

  it('reads unknown keys as absent', async () => {
    expect(await createMemoryKvStore().get('nope')).toBeUndefined()
  })

  it('replaces an existing value in place', async () => {
    const store = createMemoryKvStore()

    await store.put('k', 1)
    await store.put('k', 2)

    expect(await store.get('k')).toBe(2)
    expect(await store.entries()).toHaveLength(1)
  })

  it('reports whether a delete removed anything', async () => {
    const store = createMemoryKvStore({ k: 'v' })

    expect(await store.delete('k')).toBe(true)
    expect(await store.delete('k')).toBe(false)
    expect(await store.entries()).toEqual([])
  })
})

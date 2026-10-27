import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { BoopRepository } from '../../src/host/persistence/repository.ts'
import { HomeService } from '../../src/host/home/service.ts'

test('ensureHome creates one session and the second call does not create another', async () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-home-'))
  const cwd = path.resolve(path.join(dshHome, 'boop', 'home'))
  const db = new BoopDatabase({ path: ':memory:', wal: false, fts: false })
  db.bootstrap()
  new BoopRepository(db, () => '2026-10-28T00:00:00.000Z', () => 'id').ensureScope('scope-1', 'owner-1')
  const created = []
  const service = new HomeService({
    db,
    scopeId: 'scope-1',
    ownerId: 'owner-1',
    dshHome,
    native: {
      async observe(sessionId) {
        const known = created.find((item) => item.sessionId === sessionId)
        return { exists: Boolean(known), subagent: false, archived: false, preset: known ? 'boop' : null, cwd: known ? cwd : null }
      },
      async resolve(sessionId) {
        return { ok: created.some((item) => item.sessionId === sessionId), agent: { session: { id: sessionId }, ctx: { on() { return () => undefined } } } }
      },
      async create(input) {
        created.push(input)
        return { sessionId: input.sessionId }
      },
      async flush() { return true },
      async modelAvailable() { return false },
    },
    policy: { decide: () => 'allow' },
    now: () => '2026-10-28T00:00:00.000Z',
  })
  const first = await service.ensureHome({ requestId: 'a' })
  const second = await service.ensureHome({ requestId: 'b' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.data.state, 'ready')
  assert.equal(first.data.capabilities.send, false)
  assert.equal(second.data.mainSessionId, first.data.mainSessionId)
  assert.equal(created.length, 1)
  assert.equal(created[0].cwd, cwd)
  assert.equal(created[0].agentPreset, 'boop')
  db.close()
  fs.rmSync(dshHome, { recursive: true, force: true })
})

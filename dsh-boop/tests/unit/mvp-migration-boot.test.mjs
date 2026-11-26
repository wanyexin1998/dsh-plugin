/**
 * Startup migration order and the process-local write fence.
 *
 * bootstrap() must not rewrite meta.schema_version to the build constant.
 * An upgrade snapshots first, applies SQL and the new version in one
 * transaction, and leaves the old version in place when SQL or backup fails.
 * A fenced process cannot keep writing by reading the new owner's token.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { MIGRATIONS, migrate } from '../../src/host/persistence/migrate.ts'
import { BoopStorage } from '../../src/host/persistence/storage.ts'
import { DshAdapter } from '../../src/host/transport/dsh-adapter.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-mvp-boot-'))
after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

function file(name) {
  return path.join(root, name)
}

test('bootstrap records baseline once and does not stamp a newer or older stored version', () => {
  const db = new BoopDatabase({ path: file('baseline.sqlite') })
  const first = db.bootstrap()
  assert.equal(first.migratedFrom, null)
  assert.equal(first.futureSchema, false)
  assert.equal(db.schemaVersion(), 1)
  db.db.prepare("UPDATE meta SET value = '9' WHERE key = 'schema_version'").run()
  const second = db.bootstrap()
  assert.equal(second.futureSchema, true)
  assert.equal(db.schemaVersion(), 9)
  const refused = migrate(db, { backupDir: file('unused-backup') })
  assert.equal(refused.refused, 'future-schema')
  assert.equal(db.schemaVersion(), 9)
  assert.equal(refused.backupPath, null)
  db.close()
})

test('a failed upgrade keeps the previous version and the rows that were already there', () => {
  const db = new BoopDatabase({ path: file('rollback.sqlite') })
  db.bootstrap()
  db.db.prepare("INSERT INTO scopes(scope_id,owner_id,policy_epoch,schema_version,created_at) VALUES('s','o',1,1,'now')").run()
  const backupDir = file('rollback-backup')
  assert.throws(
    () =>
      migrate(db, {
        backupDir,
        target: 2,
        steps: [
          ...MIGRATIONS,
          {
            version: 2,
            name: 'boom',
            sql: "UPDATE meta SET value = '2' WHERE key = 'schema_version'; SELECT * FROM does_not_exist;",
          },
        ],
      }),
    /does_not_exist|no such table/i,
  )
  assert.equal(db.schemaVersion(), 1)
  const scope = db.db.prepare('SELECT scope_id FROM scopes WHERE scope_id = ?').get('s')
  assert.equal(scope.scope_id, 's')
  db.close()
})

test('an upgrade without a backup directory does not change the version', () => {
  const db = new BoopDatabase({ path: file('nobackup.sqlite') })
  db.bootstrap()
  assert.throws(() => migrate(db, { target: 2, steps: [...MIGRATIONS, { version: 2, name: 'probe', sql: '' }] }), /backup directory/)
  assert.equal(db.schemaVersion(), 1)
  db.close()
})

test('a successful upgrade snapshots first and advances the version in that same attempt', () => {
  const db = new BoopDatabase({ path: file('upgrade.sqlite') })
  db.bootstrap()
  db.db.prepare("INSERT INTO scopes(scope_id,owner_id,policy_epoch,schema_version,created_at) VALUES('s','o',1,1,'now')").run()
  const backupDir = file('upgrade-backup')
  const report = migrate(db, {
    backupDir,
    target: 2,
    steps: [
      ...MIGRATIONS,
      {
        version: 2,
        name: 'probe',
        sql: 'CREATE TABLE boop_migration_probe(id INTEGER PRIMARY KEY); INSERT INTO boop_migration_probe(id) VALUES (1);',
      },
    ],
  })
  assert.equal(report.from, 1)
  assert.equal(report.to, 2)
  assert.deepEqual(report.applied, [2])
  assert.equal(report.integrity, 'ok')
  assert.equal(report.counts.scopes, 1)
  assert.equal(db.schemaVersion(), 2)
  assert.equal(db.db.prepare('SELECT id FROM boop_migration_probe').get().id, 1)
  const bytes = fs.readFileSync(report.backupPath)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), report.backupSha256)
  const backup = new BoopDatabase({ path: report.backupPath, wal: false })
  assert.equal(backup.schemaVersion(), 1)
  backup.close()
  db.close()
})

test('opening the same version does not rewrite it or require a new snapshot', () => {
  const db = new BoopDatabase({ path: file('same.sqlite') })
  db.bootstrap()
  const report = migrate(db, { backupDir: file('same-backup') })
  assert.equal(report.from, 1)
  assert.equal(report.to, 1)
  assert.deepEqual(report.applied, [])
  assert.equal(report.backupPath, null)
  assert.equal(db.schemaVersion(), 1)
  db.close()
})

test('a process whose lease was taken over cannot write by adopting the new token', () => {
  const home = file('homes')
  fs.mkdirSync(home, { recursive: true })
  const first = new BoopStorage({ dshHome: home, holder: 'host-A', leaseTtlMs: 60_000 })
  const started = first.start()
  assert.equal(started.ok, true)
  assert.equal(started.lease.fencingToken > 0, true)
  first.repo.setMeta('probe', '1')
  clearInterval(first.heartbeat)
  first.heartbeat = null
  first.db.db.prepare('UPDATE runtime_lease SET expires_at = ?').run('0')
  assert.equal(first.checkWrite().ok, false)
  assert.throws(() => first.repo.setMeta('probe', 'stolen'), /write refused/)

  const second = new BoopStorage({ dshHome: home, holder: 'host-B', leaseTtlMs: 60_000 })
  const taken = second.start()
  assert.equal(taken.ok, true)
  assert.equal(taken.lease.fencingToken > started.lease.fencingToken, true)
  second.repo.setMeta('probe', '2')
  assert.throws(() => first.repo.setMeta('probe', '3'), /write refused/)
  assert.equal(first.checkWrite().ok, false)
  assert.equal(second.repo.getMeta('probe'), '2')
  second.close()
  first.close()
})

test('flush persists through sessionPersistence and does not resume a cold agent', async () => {
  let flushed = 0
  let resolved = 0
  const session = { id: 's1' }
  const adapter = new DshAdapter({
    ctx: {
      reflect: {
        get(name) {
          if (name === 'sessions') return { get: () => session }
          if (name === 'sessionPersistence') {
            return {
              flush: async (value) => {
                flushed += 1
                assert.equal(value, session)
              },
            }
          }
          if (name === 'sessionController') {
            return {
              resolveAgent: async () => {
                resolved += 1
                return { agent: { whenIdle: async () => undefined } }
              },
            }
          }
          return null
        },
      },
    },
  })
  await adapter.flush('s1')
  assert.equal(flushed, 1)
  assert.equal(resolved, 0)

  const cold = new DshAdapter({
    ctx: {
      reflect: {
        get(name) {
          if (name === 'sessions') return { get: () => null }
          if (name === 'sessionController') {
            return {
              resolveAgent: async () => {
                resolved += 1
                return { agent: { whenIdle: async () => undefined } }
              },
            }
          }
          return null
        },
      },
    },
  })
  await assert.rejects(() => cold.flush('s1'), /flush is unavailable/)
  assert.equal(resolved, 0)
})

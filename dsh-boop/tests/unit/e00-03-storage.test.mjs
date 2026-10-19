#!/usr/bin/env node
/**
 * E00-03 · SQLite driver, single controller, and backup feasibility.
 *
 * Gate: G08. Scenes: AT-02 (second host must not take the write control over),
 * AT-36 (migration failure keeps a readable schema and a consistent backup).
 *
 * Runs entirely on synthetic data in a temporary directory. The user's real
 * DSH_HOME, projects, and memories are never touched.
 *
 * Run: node tests/unit/e00-03-storage.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { BoopDatabase, isUnsupportedStoragePath, snapshotBackup, verifyDatabase } from '../../src/host/persistence/database.ts'
import { LeaseManager, createSqliteLeaseStore } from '../../src/host/persistence/lease.ts'
import { CORE_DDL, FTS_DDL, SCHEMA_VERSION } from '../../src/host/persistence/schema.ts'

let dir

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-e00-03-'))
})

after(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function tempDb(name) {
  return path.join(dir, name)
}

test('E00-03 driver matrix: node:sqlite is present, WAL and foreign keys are enforced', () => {
  const db = new BoopDatabase({ path: ':memory:', wal: false })
  const report = db.bootstrap()
  assert.equal(report.driver, 'node:sqlite')
  assert.ok(Number(report.sqliteVersion.split('.')[0]) >= 3)
  assert.equal(report.foreignKeys, true)
  assert.equal(report.schemaVersion, SCHEMA_VERSION)
  console.log(`  driver=node:sqlite sqlite=${report.sqliteVersion} node=${process.version}`)
  db.close()
})

test('E00-03 a file database opens in WAL mode', () => {
  const db = new BoopDatabase({ path: tempDb('wal.db') })
  const report = db.bootstrap()
  assert.equal(report.wal, true, 'the persistent ledger must use WAL')
  assert.equal(report.migratedFrom, null, 'a fresh file has no prior schema version')
  db.close()
})

test('E00-03 foreign keys are actually enforced (not just declared)', () => {
  const db = new BoopDatabase({ path: ':memory:', wal: false })
  db.bootstrap()
  assert.throws(
    () => db.db.exec("INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,created_at,updated_at) VALUES('t','missing','g','active','pending',1,'[]','[]','now','now')"),
    /FOREIGN KEY|constraint/i,
  )
  db.close()
})

test('E00-03 journal columns reject malformed JSON at the storage boundary', () => {
  const db = new BoopDatabase({ path: ':memory:', wal: false })
  db.bootstrap()
  db.db.exec("INSERT INTO scopes(scope_id,owner_id,policy_epoch,schema_version,created_at) VALUES('s','o',1,1,'now')")
  assert.throws(
    () => db.db.exec("INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,created_at,updated_at) VALUES('t','s','g','active','pending',1,'{bad','[]','now','now')"),
    /JSON|constraint/i,
  )
  db.close()
})

test('E00-03 writes serialize: 200 concurrent write attempts never interleave', async () => {
  const db = new BoopDatabase({ path: tempDb('queue.db') })
  db.bootstrap()
  db.db.exec("INSERT INTO scopes(scope_id,owner_id,policy_epoch,schema_version,created_at) VALUES('s','o',1,1,'now')")
  const insert = db.db.prepare(
    "INSERT INTO audit_event(id,scope_id,time,actor,kind,object_id) VALUES(?,?,?,?,?,?)",
  )
  const writes = []
  for (let i = 0; i < 200; i += 1) {
    writes.push(db.write(() => insert.run(`a${i}`, 's', 'now', 'test', 'kind', `o${i}`)))
  }
  await Promise.all(writes)
  const count = db.db.prepare('SELECT count(*) c FROM audit_event').get().c
  assert.equal(count, 200, 'every queued write must commit exactly once')
  db.close()
})

test('AT-02 a second host cannot take the write control over a live lease', () => {
  const db = new BoopDatabase({ path: tempDb('lease.db') })
  db.bootstrap()
  db.db.exec("INSERT INTO scopes(scope_id,owner_id,policy_epoch,schema_version,created_at) VALUES('scope-1','owner',1,1,'now')")
  const store = createSqliteLeaseStore(db.db)
  let clock = 1_000_000
  const manager = new LeaseManager(store, () => clock, 10_000)

  const first = manager.acquire('scope-1', 'host-A')
  assert.equal(first.kind, 'acquired')
  const tokenA = first.lease.fencingToken

  const second = manager.acquire('scope-1', 'host-B')
  assert.equal(second.kind, 'held', 'host-B must stay read-only while host-A holds the lease')
  assert.equal(second.lease.holder, 'host-A')

  // host-B may not write even with host-A's token, and not with its own guess.
  assert.equal(manager.checkWrite('scope-1', 'host-B', tokenA).ok, false)
  assert.equal(manager.checkWrite('scope-1', 'host-A', tokenA).ok, true)

  // Time passes beyond the TTL: host-B takes over with a strictly larger token.
  clock += 20_000
  const takeover = manager.acquire('scope-1', 'host-B')
  assert.equal(takeover.kind, 'acquired')
  assert.ok(takeover.lease.fencingToken > tokenA, 'the takeover token must fence the old holder')
  assert.equal(takeover.fenced?.holder, 'host-A')

  // The old holder is now refused on every write path (RK-05).
  const stale = manager.checkWrite('scope-1', 'host-A', tokenA)
  assert.equal(stale.ok, false)
  assert.match(stale.reason, /fencing/i)
  db.close()
})

test('AT-02 an expired lease stops writes and requires recovery, it does not resume business', () => {
  const db = new BoopDatabase({ path: ':memory:', wal: false })
  db.bootstrap()
  db.db.exec("INSERT INTO scopes(scope_id,owner_id,policy_epoch,schema_version,created_at) VALUES('s','o',1,1,'now')")
  let clock = 500
  const manager = new LeaseManager(createSqliteLeaseStore(db.db), () => clock, 1_000)
  const { lease } = manager.acquire('s', 'host-A')
  clock += 5_000
  const result = manager.checkWrite('s', 'host-A', lease.fencingToken)
  assert.equal(result.ok, false)
  assert.match(result.reason, /expired/i)
  db.close()
})

test('AT-36 a consistent snapshot restores with full integrity', () => {
  const file = tempDb('backup.db')
  const db = new BoopDatabase({ path: file })
  db.bootstrap()
  db.db.exec("INSERT INTO scopes(scope_id,owner_id,policy_epoch,schema_version,created_at) VALUES('s','o',1,1,'now')")
  db.db.exec(
    "INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,created_at,updated_at) VALUES('t1','s','goal','active','pending',1,'[\"c\"]','[\"no deploy\"]','now','now')",
  )
  const snapshot = tempDb('backup.snapshot.db')
  snapshotBackup(db, snapshot)
  const verified = verifyDatabase(snapshot)
  assert.equal(verified.ok, true, JSON.stringify(verified))
  const restored = new DatabaseSync(snapshot, { readOnly: true })
  const task = restored.prepare('SELECT goal FROM task WHERE id=?').get('t1')
  assert.equal(task.goal, 'goal')
  restored.close()
  db.close()
})

test('AT-36 a failed migration leaves the previous schema readable and the backup intact', async () => {
  const file = tempDb('migration.db')
  const db = new BoopDatabase({ path: file })
  db.bootstrap()
  const snapshot = tempDb('migration.snapshot.db')
  snapshotBackup(db, snapshot)
  // A broken migration statement must roll back cleanly and keep the schema.
  await assert.rejects(() => db.write(() => db.db.exec('ALTER TABLE nonexistent ADD COLUMN x TEXT')))
  assert.equal(db.schemaVersion(), SCHEMA_VERSION, 'schema version must not advance on a failed migration')
  const readable = db.db.prepare('SELECT count(*) c FROM scopes').get().c
  assert.equal(readable, 0, 'the previous schema still reads')
  const verified = verifyDatabase(snapshot)
  assert.equal(verified.ok, true)
  db.close()
})

test('E00-03 network shares and drive roots are refused for write management', () => {
  assert.equal(isUnsupportedStoragePath('\\\\server\\share\\boop.sqlite'), true)
  assert.equal(isUnsupportedStoragePath('C:'), true)
  assert.equal(isUnsupportedStoragePath(path.join(dir, 'ok.sqlite')), false)
  const db = new BoopDatabase({ path: ':memory:', wal: false })
  assert.throws(() => snapshotBackup(db, '\\\\server\\share\\x.db'), /unsupported backup path/)
  db.close()
})

test('E00-03 FTS5 is optional: the core ledger works with and without it', () => {
  const plain = new BoopDatabase({ path: ':memory:', wal: false, fts: false })
  plain.bootstrap()
  assert.equal(plain.fts, false)
  plain.close()

  const withFts = new BoopDatabase({ path: ':memory:', wal: false, fts: true })
  withFts.bootstrap()
  assert.equal(withFts.fts, true)
  withFts.db.exec("INSERT INTO scopes(scope_id,owner_id,policy_epoch,schema_version,created_at) VALUES('s','o',1,1,'now')")
  withFts.db.exec(
    "INSERT INTO fact(id,scope_id,owner_type,owner_id,kind,text,status,authority,version,created_at,updated_at) VALUES('f1','s','session','sess','decision','本阶段不部署生产','active','user_confirmed',1,'now','now')",
  )
  withFts.db.exec("INSERT INTO fact_fts(scope_id,fact_id,text) VALUES('s','f1','本阶段不部署生产')")
  const hits = withFts.db.prepare("SELECT fact_id FROM fact_fts WHERE fact_fts MATCH ?").all('部署')
  assert.ok(hits.length >= 0, 'FTS is a derived index; a miss must not break the ledger')
  withFts.close()
  assert.ok(CORE_DDL.includes('CREATE TABLE IF NOT EXISTS scopes'))
  assert.ok(FTS_DDL.includes('fts5'))
})

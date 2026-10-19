#!/usr/bin/env node
/**
 * E07-02 evidence · isolated backup mechanism check (synthetic ledger only).
 *
 * Exercises BOTH backup forms the runbook documents, on synthetic test data
 * under the repository's ignored `.work/` directory — never on a user profile
 * or `~/.dsh`:
 *  A. the repository's `snapshotBackup` (SQLite `VACUUM INTO`);
 *  B. the documented stop-Host one-liner using a read-only `node:sqlite`
 *     connection (`VACUUM INTO ?` with a bound destination).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BoopDatabase, snapshotBackup, verifyDatabase } from '../../../../src/host/persistence/database.ts'
import { BoopRepository } from '../../../../src/host/persistence/repository.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const WORK = path.join(ROOT, '.work', 'e07-02-backup')
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(path.join(WORK, 'backup'), { recursive: true })

const live = path.join(WORK, 'boop.sqlite')
const viaRepo = path.join(WORK, 'backup', 'boop-snapshot.sqlite')
const viaRunbook = path.join(WORK, 'backup', 'boop-runbook-snapshot.sqlite')

const db = new BoopDatabase({ path: live })
const bootstrap = db.bootstrap()
let n = 0
const repo = new BoopRepository(db, () => new Date().toISOString(), () => `bk_${++n}`)
const scope = 'boop-e0702-backup-check'
repo.ensureScope(scope, 'dsh-local-owner')
const task = repo.createTask({ scopeId: scope, goal: 'backup-check synthetic task' })
repo.audit(scope, 'e07-02/backup-check', task.id, 'system', 'synthetic fixture')
const tableCount = (handle, table) => Number(handle.db.prepare(`SELECT count(*) c FROM ${table}`).get().c)
const countsOf = (handle) => ({
  task: tableCount(handle, 'task'),
  task_revision: tableCount(handle, 'task_revision'),
  audit_event: tableCount(handle, 'audit_event'),
})
const liveCounts = countsOf(db)

/* A. repository snapshot API (`VACUUM INTO`), then close the live handle. */
snapshotBackup(db, viaRepo)
db.close()

/* B. the runbook one-liner: read-only connection, `VACUUM INTO ?` bound target. */
const { DatabaseSync } = await import('node:sqlite')
const readOnly = new DatabaseSync(live, { readOnly: true })
readOnly.prepare('VACUUM INTO ?').run(viaRunbook)
readOnly.close()

const inspect = (file) => {
  const check = verifyDatabase(file)
  const handle = new BoopDatabase({ path: file })
  const counts = countsOf(handle)
  const schemaVersion = handle.schemaVersion()
  handle.close()
  const bytes = fs.readFileSync(file)
  return {
    path: path.relative(ROOT, file).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    schemaVersion,
    counts,
    verify: check,
    countsMatch: JSON.stringify(counts) === JSON.stringify(liveCounts),
  }
}

const repositorySnapshot = inspect(viaRepo)
const runbookSnapshot = inspect(viaRunbook)
const report = {
  schemaVersion: 1,
  generatedFor: 'E07-02',
  generatedAt: new Date().toISOString(),
  isolation: {
    note: 'synthetic ledger under .work/e07-02-backup; no user profile, no ~/.dsh, no real conversation data',
    dshHomeUsed: false,
  },
  live: { path: '<repo>/.work/e07-02-backup/boop.sqlite', schemaVersion: bootstrap.schemaVersion, counts: liveCounts },
  mechanisms: {
    repository: {
      description: 'BoopDatabase snapshotBackup() = SQLite VACUUM INTO (repo API)',
      snapshot: repositorySnapshot,
    },
    runbookOneLiner: {
      description:
        "node -e \"const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(src,{readOnly:true});db.prepare('VACUUM INTO ?').run(dst);db.close()\"",
      snapshot: runbookSnapshot,
    },
  },
  verdict:
    repositorySnapshot.verify.ok &&
    runbookSnapshot.verify.ok &&
    repositorySnapshot.countsMatch &&
    runbookSnapshot.countsMatch
      ? 'PASS (both documented backup mechanisms on synthetic data)'
      : 'FAIL',
  notVerified: [
    'backup of a real user profile / real ledger (NOT_RUN; runbook step only)',
    'restore-drill on a real Host and rollback to an older plugin (NOT_RUN)',
    'file-copy fallback while WAL is active (explicitly NOT recommended by the runbook)',
  ],
}
fs.writeFileSync(path.join(WORK, 'backup-check.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))

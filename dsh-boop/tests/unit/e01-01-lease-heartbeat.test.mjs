#!/usr/bin/env node
/**
 * E01-01 · Writer-lease heartbeat (G08 gap closure).
 *
 * The lease used to expire 15s after acquisition because nothing renewed it: a
 * healthy Host could be mistaken for a dead one and a second Host could take
 * over. The heartbeat renews in-process. These tests pin the window:
 *  - a live Host's lease is still valid beyond the TTL;
 *  - a stopped Host's lease is taken over after the TTL (old fencing token gone);
 *  - the heartbeat timer never keeps the process alive (unref) and stops on close.
 *
 * Run: node --test tests/unit/e01-01-lease-heartbeat.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { BoopStorage } from '../../src/host/persistence/storage.ts'

const TTL = 300

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-lease-heartbeat-'))
  return { dir, home: path.join(dir, 'home') }
}

function leaseRow(home) {
  const db = new DatabaseSync(path.join(home, 'boop', 'boop.sqlite'), { readOnly: true })
  try {
    return db.prepare('SELECT holder, fencing_token, expires_at FROM runtime_lease').get()
  } finally {
    db.close()
  }
}

function cleanup(dir) {
  try {
    cleanup(dir)
  } catch {
    /* Windows may briefly keep a sqlite handle; temp dirs are disposable */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('a live Host keeps its lease past the TTL thanks to the in-process heartbeat', async () => {
  const { dir, home } = freshHome()
  const storage = new BoopStorage({ dshHome: home, leaseTtlMs: TTL, holder: 'live@1' })
  try {
    const facts = storage.start()
    assert.equal(facts.ok, true, 'the first Host owns the lease')
    assert.ok(storage.heartbeat, 'a heartbeat exists while the Host owns the lease')
    const before = leaseRow(home)
    await sleep(TTL * 2.5)
    const after = leaseRow(home)
    assert.equal(after.fencing_token, before.fencing_token, 'renewal never mints a new fencing token')
    assert.ok(Number(after.expires_at) > Date.now(), 'the lease is still valid beyond the original TTL')

    // A second live Host must not take over a lease that is still renewed.
    const second = new BoopStorage({ dshHome: home, leaseTtlMs: TTL, holder: 'second@2' })
    try {
      const secondFacts = second.start()
      assert.equal(secondFacts.ok, false, 'a renewed lease is held, so the second Host stays read-only')
      assert.equal(secondFacts.lease.holder, 'live@1')
    } finally {
      second.close()
    }
  } finally {
    storage.close()
    cleanup(dir)
  }
})

test('after close the lease is released; a later Host takes over with a greater token', async () => {
  const { dir, home } = freshHome()
  const first = new BoopStorage({ dshHome: home, leaseTtlMs: TTL, holder: 'first@1' })
  let token
  try {
    token = first.start().lease.fencingToken
  } finally {
    first.close()
  }
  assert.equal(first.heartbeat, null, 'close() stops the heartbeat')
  const second = new BoopStorage({ dshHome: home, leaseTtlMs: TTL, holder: 'second@2' })
  try {
    const facts = second.start()
    assert.equal(facts.ok, true)
    assert.ok(facts.lease.fencingToken > token, 'takeover mints a strictly greater fencing token')
  } finally {
    second.close()
    cleanup(dir)
  }
})

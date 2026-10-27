#!/usr/bin/env node
/**
 * The manifest admits the two hosts we have actually checked, and a process
 * that is not the desktop shell keeps the rc.2 baseline the host suite reads.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { readHostIdentity } from '../../src/host/host-identity.ts'

const root = path.resolve(import.meta.dirname, '../..')

test('engines.dsh names rc.2 and rc.3 and no compatibility exemption is shipped', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.engines.dsh, '0.2.1-rc.2 || 0.2.1-rc.3')
  assert.equal(fs.existsSync(path.join(root, 'compatibility.json')), false)
})

test('plain Node reports the installed DSH version and does not invent a commit', () => {
  const identity = readHostIdentity()
  assert.equal(identity.version, '0.2.1-rc.2')
  assert.equal(identity.commit, 'unknown')
})

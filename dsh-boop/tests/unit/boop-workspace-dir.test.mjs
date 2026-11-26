import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import {
  boopWorkspacePath,
  concealBoopWorkspaceRegistration,
  ensureBoopWorkspace,
  ensureBoopWorkspaceDirectory,
  sameWorkspaceDir,
} from '../../src/host/boop-workspace-dir.ts'

test('the BOOP workspace directory is under this plugin server tree', () => {
  const dir = boopWorkspacePath()
  assert.equal(path.basename(dir), 'workspace')
  assert.equal(path.basename(path.dirname(dir)), 'server')
  assert.equal(path.basename(path.dirname(path.dirname(dir))), 'dsh-boop')
})

test('the directory is created and can be created again', () => {
  const dir = ensureBoopWorkspaceDirectory()
  assert.equal(fs.statSync(dir).isDirectory(), true)
  assert.equal(ensureBoopWorkspaceDirectory(), dir)
})

test('the workspace ships AGENTS.md for the main-session voice reminder', () => {
  const file = path.join(ensureBoopWorkspaceDirectory(), 'AGENTS.md')
  assert.equal(fs.statSync(file).isFile(), true)
  assert.match(fs.readFileSync(file, 'utf8'), /熟同事/)
})

test('the BOOP directory is not registered as a visible workspace', async () => {
  const dir = ensureBoopWorkspaceDirectory()
  const created = []
  const deleted = []
  const ctx = {
    workspaceRegistry: {
      create: async (target, title) => {
        created.push({ target, title })
        return { id: 'ws-boop', path: target, title }
      },
      resolveByPath: async () => ({ id: 'ws-boop', path: dir, title: 'BOOP' }),
      delete: async (id) => {
        deleted.push(id)
        return true
      },
    },
  }
  const binding = await ensureBoopWorkspace(ctx)
  assert.equal(binding.path, dir)
  assert.equal(binding.workspaceId, null)
  assert.deepEqual(created, [], 'the directory is not added to the left-sidebar workspace list')
  assert.deepEqual(deleted, ['ws-boop'])
  assert.equal(sameWorkspaceDir(dir, dir + '/'), true)
})

test('conceal is a no-op when the directory was never registered', async () => {
  const deleted = []
  await concealBoopWorkspaceRegistration({
    workspaceRegistry: {
      resolveByPath: async () => undefined,
      list: () => [],
      delete: async (id) => {
        deleted.push(id)
        return true
      },
    },
  })
  assert.deepEqual(deleted, [])
})

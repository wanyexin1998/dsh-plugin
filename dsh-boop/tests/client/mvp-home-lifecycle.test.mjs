/**
 * Home controller and choice-card rules. No browser bundle required.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HomeController } from '../../src/client/home/controller.ts'
import { readWorkChoice } from '../../src/client/home/read-work-choice.ts'
import { BOOP_HOME_CSS } from '../../src/client/home/home-styles.ts'
import { formatSessionReferenceMention } from '../../src/shared/session-mention.ts'

function host() {
  const calls = []
  let connection = 'connected'
  const listeners = new Set()
  let released = 0
  const api = {
    calls,
    released: () => released,
    setConnection(value) {
      connection = value
      for (const listener of listeners) listener()
    },
    controller: new HomeController({
      async call(endpoint, args) {
        calls.push({ endpoint, args })
        if (endpoint === 'boop/ensureHome') {
          return { data: { state: 'ready', mainSessionId: 'boop-main', bindingVersion: 1, capabilities: { send: true, readSources: true, delegate: true, stop: true, reasonCodes: [] } } }
        }
        if (endpoint === 'boopTasks/listV2') {
          return { data: { items: [{ taskId: 't1', title: '窄屏', productState: 'running', statusText: '正在处理', target: { sessionId: 's', workspaceId: null, sessionTitle: '原会话', workspaceTitle: null }, taskVersion: 1, stateSeq: 1, needsAttentionReason: null, latestAction: null, latestResult: null, confirmation: { state: 'unavailable' }, verification: { state: 'not_checked', summary: '', checks: [] }, availableActions: ['view'], updatedAt: '2026-10-28T00:00:00.000Z' }] } }
        }
        return { ok: true }
      },
      retain() {
        return { id: 'boop-main', native: { id: 'boop-main' }, ready: Promise.resolve(), release() { released += 1 } }
      },
      connection: {
        getSnapshot: () => connection,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        reconnect() { connection = 'connected' },
      },
      selectPanel() {},
      openSource() {},
      async insertReference() { return true },
      async setDraftText() { return true },
    }),
  }
  return api
}

test('task refresh keeps the same retained session', async () => {
  const env = host()
  await env.controller.mount()
  const first = env.controller.getSnapshot().reference
  await env.controller.refreshTasks()
  assert.equal(env.controller.getSnapshot().reference, first)
  assert.equal(env.released(), 0)
  assert.equal(env.controller.getSnapshot().tasks.length, 1)
  env.controller.destroy()
  assert.equal(env.released(), 1)
})

test('a late ensureHome does not publish after destroy', async () => {
  let releaseEnsure
  const env = host()
  const original = env.controller
  const pending = new Promise((resolve) => { releaseEnsure = resolve })
  original.host = undefined
  const calls = []
  const controller = new HomeController({
    async call(endpoint) {
      calls.push(endpoint)
      if (endpoint === 'boop/ensureHome') return pending
      return { data: { items: [] } }
    },
    retain() { throw new Error('should not retain') },
    connection: { getSnapshot: () => 'connected', subscribe: () => () => undefined, reconnect() {} },
    selectPanel() {},
    openSource() {},
    async insertReference() { return false },
    async setDraftText() { return false },
  })
  const mounting = controller.mount()
  controller.destroy()
  releaseEnsure({ data: { state: 'ready', mainSessionId: 'late', bindingVersion: 2, capabilities: { send: true, readSources: false, delegate: false, stop: true, reasonCodes: [] } } })
  await mounting
  assert.equal(controller.getSnapshot().reference, null)
})

test('choice cards accept only a complete boop_catalog result', () => {
  const mention = formatSessionReferenceMention({ sessionId: 'sess-1', label: '原开发' })
  const value = { schemaVersion: 2, kind: 'boop.catalog', ok: true, data: { mode: 'work', originUserMessageId: 'u1', sourceSeq: 4, generatedAt: 't', truncated: false, candidates: [{ sessionId: 'sess-1', workspaceId: null, title: '原开发', workspaceTitle: null, mention, selectionKey: 'k', activity: 'idle', lastActivityAt: null, preview: null }] } }
  const nodes = [{ kind: 'tool-result', name: 'boop_catalog', isError: false, call: { id: 'c' }, content: [{ type: 'text', text: JSON.stringify(value) }] }]
  assert.equal(readWorkChoice(nodes)?.candidates.length, 1)
  assert.equal(readWorkChoice([{ kind: 'tool-result', name: 'boop_catalog', isError: false, call: null, content: [{ type: 'text', text: JSON.stringify(value) }] }]), null)
  assert.equal(readWorkChoice([{ kind: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }] }]), null)
})

test('home css folds composer chrome without hiding approvals', () => {
  assert.match(BOOP_HOME_CSS, /\[data-slot="conversation\.input\.model"\]/)
  assert.match(BOOP_HOME_CSS, /\[data-composer-dock\]/)
  assert.doesNotMatch(BOOP_HOME_CSS, /conversation\.input\.dock/)
  assert.doesNotMatch(BOOP_HOME_CSS, /data-composer-overlay/)
  assert.match(BOOP_HOME_CSS, /\[data-boop-home\]/)
  assert.doesNotMatch(BOOP_HOME_CSS, /(^|\n)\s*body\s*\{/)
})

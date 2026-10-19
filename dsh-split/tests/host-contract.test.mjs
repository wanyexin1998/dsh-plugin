#!/usr/bin/env node
/**
 * Run: node tests/host-contract.test.mjs
 * Baseline reproduction: node tests/host-contract.test.mjs --before
 * Override installation: DSH_ASAR=/absolute/path/to/app.asar
 *
 * This is an offline integration test against the installed SlotRegistry,
 * SlotCore and React renderer, not a claim of live Electron acceptance. The
 * synthetic conversation body observes the actual factory props and scope;
 * geometry, domain stores and Cordis effect ownership are bounded doubles.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { artifactEvidence, createHarness, projectRoot } from './helpers/host-contract-harness.mjs'

const before = process.argv.includes('--before')
const options = before ? { sourceDirectory: path.join(projectRoot, 'docs/evidence/bugfix-20261016/before/src') } : {}
console.log('renderer artifact:', JSON.stringify(artifactEvidence))
console.log('plugin source:', before ? options.sourceDirectory : path.join(projectRoot, 'src'))

async function fixture(t, extra = {}) {
  const h = await createHarness({ ...options, ...extra })
  t.after(async () => {
    await h.close()
    if (before && h.diagnostics.length > 0) t.diagnostic([...new Set(h.diagnostics)].join('\n'))
  })
  assert.ok(h.mainEntry, 'plugin must register its main entry')
  return h
}

function split(h, id, direction = 'right') { h.menu(`dsh-split.${direction === 'below' ? 'down' : 'right'}`).inject().run(id) }
function phase(h, id) {
  const element = h.conversation(id)
  assert.ok(element, `session ${id} must render through the real session-scoped factory dispatch`)
  return element.getAttribute('data-test-phase')
}
function sorted(items) { return [...items].sort() }

test('rc.2 inject binding preserves workbench callbacks under a non-reserved name', async (t) => {
  const h = await fixture(t)
  const raw = h.mainEntry.inject()
  const bound = h.renderer.__contract.runInject(h.mainEntry)
  assert.ok(bound.workbenchActions, 'workbench callbacks disappeared after real rc.2 inject binding: top-level hooks is reserved')
  assert.equal(bound.workbenchActions, raw.workbenchActions, 'action identity must remain stable across snapshots')
  for (const method of ['retain', 'onFocus', 'onClose', 'onToggleSidebar', 'onGeometryChange']) {
    assert.equal(typeof bound.workbenchActions[method], 'function', `${method} must survive renderer injection`)
  }
  assert.equal('hooks' in raw, false, 'imperative callbacks must not occupy the observable hooks contract')
  assert.equal('useRetain' in bound, false, 'imperative retain must not become an observable selector hook')
})

test('main declares a strict session child and receives the real SessionProvider seat', async (t) => {
  const h = await fixture(t)
  assert.equal(h.registry.spec('dsh-split.session')?.kind, 'single', 'main must declare the child before registration')
  assert.equal(h.registry.spec('dsh-split.session')?.scope, 'session')
  assert.equal(h.registry.entries('dsh-split.session').length, 1)
  const host = h.registry.hostFace()
  const { kit } = h.renderer.__contract.standardKit(host, h.mainEntry, 'root', host.root.getSnapshot())
  assert.equal(typeof kit.SessionProvider, 'function', 'rc.2 only grants this seat for declared scoped children')
  assert.equal(typeof kit.renderSlot, 'function')
  assert.equal(kit.useSession, undefined, 'the root workbench must not receive a foreground session selector')
  assert.equal(kit.useConversation, undefined)
  assert.throws(() => kit.renderSlot('undeclared.session', {}), /not declared/)
})

test('each pane uses its own live session and conversation phase through the real renderer', async (t) => {
  const h = await fixture(t)
  split(h, 'B')
  split(h, 'C', 'below')
  await h.mount()
  assert.equal(phase(h, 'A'), 'active')
  assert.equal(phase(h, 'B'), 'settling')
  assert.equal(phase(h, 'C'), 'hero')
  assert.equal(h.conversation('C').getAttribute('data-test-hero'), 'true')
  assert.deepEqual(sorted(h.counts.mounted), ['A', 'B', 'C'])
  assert.deepEqual(sorted(h.counts.retained), ['A', 'B', 'C'])
  for (const id of ['A', 'B', 'C']) {
    assert.equal(h.pane(id).querySelectorAll('[data-test-conversation]').length, 1, 'one editable presentation per session')
    assert.equal(h.conversation(id).closest('[data-test-session-area]').getAttribute('data-test-session-area'), id)
    assert.equal(h.conversation(id).getAttribute('data-test-variant'), 'embedded')
  }

  await h.flush(() => h.current.set(h.records.get('C').binding))
  assert.equal(phase(h, 'A'), 'active')
  assert.equal(phase(h, 'B'), 'settling', 'foreground session changes must not change B phase')
  assert.equal(phase(h, 'C'), 'hero')

  await h.flush(() => h.records.get('B').session.set({ ...h.records.get('B').session.getSnapshot(), openState: 'open', blank: false, awaitingFirstTurn: false }))
  assert.equal(phase(h, 'B'), 'active', 'loading completion must reveal B composer')
  assert.equal(phase(h, 'C'), 'hero', 'B loading completion must not change C phase')
  await h.flush(() => h.records.get('C').conversation.set({ activeTargets: new Set(['target-c']) }))
  assert.equal(phase(h, 'C'), 'active', 'active conversation targets must affect only their session')
  assert.equal(h.conversation('C').getAttribute('data-test-hero'), 'false')
  assert.deepEqual(sorted(h.counts.mounted), ['A', 'B', 'C'], 'phase changes must preserve component incarnations')
  assert.equal(h.failures.length, 0)
  assert.deepEqual(h.diagnostics, [])
})

test('split, focus, sidebar and close preserve other sessions; unload releases everything', async (t) => {
  const h = await fixture(t)
  const hostAnnouncements = []
  h.dom.window.document.addEventListener('dsh-sidebar-host-change', () => {
    hostAnnouncements.push(h.dom.window.document.documentElement.hasAttribute('data-dsh-plugin-main-host'))
  })
  split(h, 'B')
  await h.mount()
  assert.equal(phase(h, 'A'), 'active')
  assert.equal(h.pane('A').getAttribute('data-dsh-split-session'), 'A')
  assert.equal(h.pane('B').getAttribute('data-dsh-split-session'), 'B')
  assert.ok(hostAnnouncements.includes(true), 'sidebar owner must be told when the workbench claims the host')
  const aComposer = h.conversation('A').querySelector('textarea')
  const bComposer = h.conversation('B').querySelector('textarea')
  aComposer.value = 'unsent draft A'
  bComposer.value = 'unsent draft B'
  const originalActions = h.mainEntry.inject().workbenchActions

  await h.flush(() => h.pane('A').dispatchEvent(new h.dom.window.Event('pointerdown', { bubbles: true })))
  assert.equal(h.pane('A').getAttribute('data-dsh-split-focused'), 'true')
  await h.flush(() => h.pane('B').dispatchEvent(new h.dom.window.Event('pointerdown', { bubbles: true })))
  assert.equal(h.pane('B').getAttribute('data-dsh-split-focused'), 'true')
  await h.flush(() => h.pane('A').querySelector('[data-action="sidebar"]').click())
  assert.equal(h.pane('A').querySelector('[data-dsh-sidebar-host]').getAttribute('data-dsh-sidebar-collapsed'), 'true')

  await h.flush(() => split(h, 'C', 'below'))
  assert.equal(h.geometry.instances.length, 1, 'layout updates must not recreate the docking engine')
  assert.equal(h.geometry.instances[0].groups.at(-1).direction, 'below')
  assert.equal(h.mainEntry.inject().workbenchActions, originalActions)
  assert.equal(h.conversation('A').querySelector('textarea'), aComposer)
  assert.equal(h.conversation('B').querySelector('textarea'), bComposer)
  assert.equal(aComposer.value, 'unsent draft A')
  assert.equal(bComposer.value, 'unsent draft B')
  assert.deepEqual(sorted(h.counts.retained), ['A', 'B', 'C'])
  assert.deepEqual(h.counts.released, [])

  await h.flush(() => h.pane('B').querySelector('[aria-label="关闭此会话视图，不删除会话"]').click())
  assert.equal(h.conversation('B'), null)
  assert.deepEqual(h.counts.released, ['B'], 'closing B must release only B')
  assert.deepEqual(h.counts.unmounted, ['B'])
  assert.equal(h.conversation('A').querySelector('textarea'), aComposer)
  assert.deepEqual(sorted(h.counts.retained), ['A', 'B', 'C'])
  assert.equal(document.documentElement.hasAttribute('data-dsh-plugin-main-host'), true)

  await h.unload()
  assert.deepEqual(sorted(h.counts.released), ['A', 'B', 'C'], 'plugin unload must release every remaining reference once')
  assert.deepEqual(sorted(h.counts.unmounted), ['A', 'B', 'C'])
  assert.equal(h.geometry.instances[0].disposed, true)
  assert.equal(document.documentElement.hasAttribute('data-dsh-plugin-main-host'), false)
  assert.equal(hostAnnouncements.at(-1), false, 'unload must announce marker removal so sidebar holds can be released')
  assert.equal(document.querySelector('[data-plugin-css="dsh-split/workbench"]'), null)
  assert.equal(h.registry.entries('main').length, 0)
  assert.equal(h.registry.spec('dsh-split.session'), undefined)
  for (const record of h.records.values()) {
    assert.equal(record.session.subscriberCount, 0)
    assert.equal(record.conversation.subscriberCount, 0)
  }
  assert.equal(h.failures.length, 0)
  assert.deepEqual(h.diagnostics, [])
})

test('restored panes recover when the session catalog arrives, without rebinding ready panes', async (t) => {
  const h = await fixture(t, { restoreSessions: ['A', 'B'], withheldSessions: ['B'] })
  await h.mount()
  await h.flush(() => new Promise((resolve) => h.dom.window.setTimeout(resolve, 10)))
  assert.equal(phase(h, 'A'), 'active')
  assert.equal(h.conversation('B'), null)
  assert.deepEqual(h.counts.retained, ['A'])
  const aComposer = h.conversation('A').querySelector('textarea')
  aComposer.value = 'keep during catalog hydration'

  await h.flush(() => h.summaries.set({ byId: {
    ...h.summaries.getSnapshot().byId, B: { title: 'Session B', blank: false },
  } }))
  assert.equal(phase(h, 'B'), 'settling', 'restored B must retry after its catalog entry becomes available')
  assert.deepEqual(sorted(h.counts.retained), ['A', 'B'])
  assert.equal(h.counts.retained.filter((id) => id === 'A').length, 1)
  assert.equal(h.conversation('A').querySelector('textarea'), aComposer)
  assert.equal(aComposer.value, 'keep during catalog hydration')
  assert.deepEqual(h.counts.released, [])

  const attemptCount = h.counts.retainAttempts.length
  await h.flush(() => h.summaries.set({ byId: {
    ...h.summaries.getSnapshot().byId, A: { ...h.summaries.getSnapshot().byId.A, title: 'Renamed A' },
  } }))
  assert.equal(h.counts.retainAttempts.length, attemptCount, 'title-only catalog updates must not re-retain sessions')
  assert.equal(h.failures.length, 0)
  assert.ok(h.diagnostics.every((message) => message.includes('retain') && message.includes('B')), 'only the deliberately delayed B retain may be reported')
})

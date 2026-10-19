/**
 * Historical diagnostic for the two host gaps, pinned to the pre-fix backup.
 * Executes the old patched functions against synthetic sessions/files, with no DSH
 * connection. A reproduced issue is evidence of a defect, NOT an acceptance-test pass.
 * Usage: node tools/reproduce-host-gaps.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'

function region(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0) throw new Error('Host source boundary changed: ' + startMarker)
  return source.slice(start, end)
}

const sidebarPath = new URL('../docs/evidence/bugfix-20261016/before-host-fixes/patched/dsh-client-ui-sidebar-right/lib/client.js', import.meta.url)
const attachmentPath = new URL('../docs/evidence/bugfix-20261016/before-host-fixes/patched/dsh-client-ui-attachment/lib/client.js', import.meta.url)
const sidebar = readFileSync(sidebarPath, 'utf8')
const attachment = readFileSync(attachmentPath, 'utf8')
const hash = (source) => createHash('sha256').update(source).digest('hex')

const lifecycle = []
const SidebarViews = new Function('_deepseek_ai_dsh_client_store',
  region(sidebar, 'var SidebarSessionView = class', '//#region ../../util/crypto/src/index.ts') +
  '\nreturn SidebarSessionViews',
)({ createSnapshotStore(initial) {
  let current = initial
  return { getSnapshot: () => current, set: (value) => { current = value } }
} })
const views = new SidebarViews({ retain(sessionId) {
  lifecycle.push({ event: 'retain', sessionId })
  return { sessionId, ready: Promise.resolve(), release() { lifecycle.push({ event: 'release', sessionId }) } }
} })
views.select('synthetic-A')
const releaseMountA = views.mount(views.source.getSnapshot()[0].reference)
views.select('synthetic-B')
const sidebarSessionsAfterFocusB = views.source.getSnapshot().map((view) => view.sessionId)
releaseMountA()
const releasedAAfterFocusB = lifecycle.some((entry) => entry.event === 'release' && entry.sessionId === 'synthetic-A')
views.dispose()

const dom = new JSDOM('<div data-dsh-split-surface="synthetic-A"></div><div data-dsh-split-surface="synthetic-B"></div>')
const { document } = dom.window
const installDrop = new Function('window', 'document', 'droppedDirectories',
  region(attachment, 'function installDocumentDropEvents(', '//#endregion') +
  '\nreturn installDocumentDropEvents',
)(dom.window, document, () => [])
const receivedBy = []
const disposeA = installDrop(true, () => receivedBy.push('synthetic-A'), { current: 0 }, () => {})
const disposeB = installDrop(true, () => receivedBy.push('synthetic-B'), { current: 0 }, () => {})
const event = new dom.window.Event('drop', { bubbles: true, cancelable: true })
Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [{ name: 'synthetic-only.txt' }] } })
document.querySelector('[data-dsh-split-surface="synthetic-B"]').dispatchEvent(event)
disposeA()
disposeB()
dom.window.close()

const report = {
  date: '2026-10-16',
  mode: 'historical pre-fix baseline, actual old patched functions with synthetic dependencies',
  sources: { sidebar: hash(sidebar), attachment: hash(attachment) },
  sidebar: {
    scenario: 'A remains mounted; select B; A has no keepMounted tab holds',
    expectedVisibleSessions: ['synthetic-A', 'synthetic-B'],
    actualVisibleSessions: sidebarSessionsAfterFocusB,
    releasedAAfterFocusB,
    reproduced: !sidebarSessionsAfterFocusB.includes('synthetic-A') && releasedAAfterFocusB,
  },
  fileDrop: {
    scenario: 'A document listener registered first; drop a synthetic file inside B',
    expectedRecipient: 'synthetic-B',
    actualRecipients: receivedBy,
    reproduced: receivedBy.length === 1 && receivedBy[0] === 'synthetic-A',
  },
  limitation: 'Does not run the full native Sidebar, attachment upload, transport, terminal, or model.',
}
const reportPath = new URL('../docs/evidence/bugfix-20261016/remaining-host-gaps.json', import.meta.url)
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))

#!/usr/bin/env node
/**
 * P0 probe-report evaluator.
 *
 * Reads the JSON copied from the in-app probe panel (or the console's
 * `[dsh-split-probe] report …` line) and turns it into the G0 criteria verdicts
 * listed in `docs/evidence/README.md`. Read-only: it prints a table and sets an
 * exit code (0 = every critical criterion carries evidence, 2 = something is
 * missing or failed).
 *
 * Usage:
 *   node tools/p0-report.mjs docs/evidence/p0-probe-report.json
 *   node tools/p0-report.mjs --self-test        # run the built-in fixtures
 */
import { readFileSync } from 'node:fs'

/* ------------------------------------------------------------------ parsing -- */

function parseReport(text) {
  const trimmed = text.trim()
  // The console line is `[dsh-split-probe] report {json}`; the button copies bare JSON.
  const marker = trimmed.lastIndexOf('[dsh-split-probe] report ')
  const body = marker === -1 ? trimmed : trimmed.slice(marker + '[dsh-split-probe] report '.length)
  const parsed = JSON.parse(body)
  if (!Array.isArray(parsed.rows)) throw new Error('report has no rows[]')
  return parsed
}

function detail(row) {
  if (row === undefined) return null
  if (row.detail === null || row.detail === undefined) return null
  if (typeof row.detail === 'object') return row.detail
  try {
    return JSON.parse(row.detail)
  } catch (error) {
    return { text: String(row.detail) }
  }
}

function find(rows, id) {
  return rows.find((row) => row.id === id)
}

/* ----------------------------------------------------------------- criteria -- */

const CRITICAL = []

function criterion(name, critical, evaluate) {
  CRITICAL.push({ name, critical, evaluate })
}

criterion('W001 能力发现已取到', true, (rows) => {
  const row = find(rows, 'W001/discovery')
  if (row === undefined) return ['missing', 'no W001/discovery row']
  const d = detail(row)
  const sidebar = d !== null && d.services !== undefined ? d.services.sidebarRight : null
  const ok = Array.isArray(sidebar) && sidebar.length > 0
  return [ok ? 'pass' : 'warn', 'sidebarRight surface: ' + (Array.isArray(sidebar) ? sidebar.slice(0, 6).join(',') : String(sidebar))]
})

criterion('自建 main key 生效且保活可读（P-1 判据）', true, (rows) => {
  const row = find(rows, 'W003-a/select-own-main-key')
  if (row === undefined) return ['missing', 'no W003-a row']
  const d = detail(row)
  if (d === null) return ['missing', 'no detail in W003-a']
  if (d.selectError !== null && d.selectError !== undefined) {
    return ['fail', 'selectPanel threw, the public host-switch path does not work: ' + String(d.selectError)]
  }
  const mounted = d.during !== undefined && d.during.workbenchMounted === true
  if (!mounted) return ['fail', 'workbench component did not mount while its key was selected']
  // `sameRetention: false` is a finding (it is exactly what patch P-1 has to restore), not a gap in evidence.
  return ['info', 'workbench mounted with the key selected; retainedBy.mainView unchanged: ' + String(d.sameRetention)
    + (d.sameRetention === true ? '' : ' → P-1 must keep the session retained while a plugin host is selected')]
})

criterion('唯一编辑根：第二份呈现的后果与恢复（F12）', true, (rows) => {
  const row = find(rows, 'W003-b/second-presentation')
  if (row === undefined) return ['missing', 'no W003-b/second-presentation row']
  const d = detail(row)
  if (d === null) return ['missing', 'no detail in W003-b']
  const roots = (side) => (side === undefined || side === null ? null : side.editableRoots)
  const lexical = (side) => (side === undefined || side === null || side.lexicalRoots === undefined
    ? null
    : { roots: side.lexicalRoots, inProbe: side.lexicalInProbe })
  const before = roots(d.before)
  const during = roots(d.during)
  const after = roots(d.after)
  const lexBefore = lexical(d.before)
  const lexDuring = lexical(d.during)
  const lexAfter = lexical(d.after)
  const summary = 'editable roots ' + String(before) + ' → ' + String(during) + ' → ' + String(after)
    + '; lexical bindings ' + JSON.stringify(lexBefore) + ' → ' + JSON.stringify(lexDuring) + ' → ' + JSON.stringify(lexAfter)
    + '; native root moved out: ' + String(d.nativeRootMovedOut)
  if (lexDuring !== null && lexDuring.roots > 1) {
    return ['fail', 'two elements carry the Lexical binding at once: ' + summary]
  }
  if (before !== null && during !== null && during > before) {
    return ['fail', 'two editable roots coexist — the host enforces nothing: ' + summary]
  }
  if (before !== null && after !== null && after !== before) {
    return ['fail', 'the editable-root count did not recover after unmounting the copy: ' + summary]
  }
  const notes = []
  if (lexDuring !== null && lexDuring.inProbe === 1) notes.push('the shared editor was re-hosted into the copy')
  if (lexAfter !== null && lexAfter.roots === 0) notes.push('unmounting the copy cleared the binding — only a remount restores the native composer (F12: never mount a second presentation)')
  return ['info', summary + (notes.length === 0 ? '' : ' → ' + notes.join('; '))]
})

criterion('人工输入结论（原生 composer 是否仍可用）', true, (rows) => {
  const row = find(rows, 'W003-b/manual-typing')
  if (row === undefined) return ['missing', 'user did not record a typing verdict while the copy was mounted']
  return ['info', 'user verdict while the copy was mounted: ' + row.status]
})

criterion('两份 Sidebar 的可见面（F03）', true, (rows) => {
  const row = find(rows, 'W004/session-switch-sidebar')
  if (row === undefined) return ['missing', 'no W004 row']
  const d = detail(row)
  if (d === null) return ['missing', 'no detail in W004']
  const marked = (side) => (side === undefined || side === null || side.rightbar === undefined || !Array.isArray(side.rightbar.marked)
    ? -1
    : side.rightbar.marked.length)
  return ['info', 'marked right-column nodes before/during/after: ' + marked(d.before) + '/' + marked(d.during) + '/' + marked(d.after)
    + '; session count ' + String(d.sessionIds)]
})

criterion('Dockview 受限配置与移动语义（W005）', true, (rows) => {
  const row = find(rows, 'W005/dockview-restricted')
  if (row === undefined) return ['missing', 'no W005 row']
  const d = detail(row)
  if (d === null) return ['missing', 'no detail in W005']
  if (d.constructError !== null && d.constructError !== undefined) {
    return ['fail', 'the restricted option set was rejected: ' + String(d.constructError)]
  }
  if (d.componentSurvivedMove !== true) {
    return ['fail', 'the component DOM node did not survive the public move (remove+add behaviour): '
      + 'moveError=' + String(d.moveError)]
  }
  const max = d.maximize === null || d.maximize === undefined ? 'n/a' : JSON.stringify(d.maximize)
  return ['pass', 'panels ' + JSON.stringify(d.added) + '; maximize ' + max
    + '; dnd ' + JSON.stringify(d.dndCapabilities) + '; snapshot keys ' + JSON.stringify(d.snapshotKeys)
    + (d.moveError === null || d.moveError === undefined ? '' : '; move note: ' + String(d.moveError))]
})

/* -------------------------------------------------------------------- report -- */

function evaluate(rows) {
  const results = CRITICAL.map((entry) => {
    const [status, note] = entry.evaluate(rows)
    return { name: entry.name, critical: entry.critical, status, note }
  })
  const blocking = results.filter((r) => r.critical && r.status !== 'pass' && r.status !== 'info')
  return { results, blocking }
}

function print(report, results, blocking) {
  console.log('probe report: ' + String(report.probe ?? '(unknown)') + ' @ ' + String(report.at ?? '(no timestamp)') + ' — ' + report.rows.length + ' rows')
  console.log('')
  for (const row of results) {
    const mark = row.status === 'pass' ? 'PASS' : row.status === 'info' ? 'INFO' : row.status.toUpperCase()
    console.log('  [' + mark.padEnd(7) + '] ' + row.name)
    console.log('            ' + row.note)
  }
  console.log('')
  console.log(blocking.length === 0
    ? 'G0 evidence: every critical criterion carries evidence — fill docs/gates/P0.md and request the patch authorization.'
    : 'G0 evidence incomplete: ' + blocking.length + ' critical criterion/criteria lack pass evidence.')
}

const arg = process.argv[2]
if (arg === '--self-test') {
  let failures = 0
  const check = (label, condition) => {
    console.log((condition ? '  ok   ' : '  FAIL ') + label)
    if (!condition) failures += 1
  }
  const passing = {
    probe: 'dsh-split-probe',
    at: 'self-test',
    rows: [
      { id: 'W001/discovery', status: 'info', detail: { services: { sidebarRight: ['openResource', 'isExpanded'] } } },
      { id: 'W003-a/select-own-main-key', status: 'info', detail: { selectError: null, sameRetention: true, during: { workbenchMounted: true, panel: { activePanelId: 'dsh-split-probe-workbench' } } } },
      { id: 'W003-b/second-presentation', status: 'info', detail: { nativeRootMovedOut: true, before: { editableRoots: 1, lexicalRoots: 1, lexicalInProbe: 0 }, during: { editableRoots: 1, lexicalRoots: 1, lexicalInProbe: 1 }, after: { editableRoots: 1, lexicalRoots: 0, lexicalInProbe: 0 } } },
      { id: 'W003-b/manual-typing', status: 'pass', detail: { note: 'ok' } },
      { id: 'W004/session-switch-sidebar', status: 'info', detail: { before: { rightbar: { marked: ['a', 'b'] } }, during: { rightbar: { marked: ['a', 'b', 'c'] } }, after: { rightbar: { marked: ['a'] } } } },
      { id: 'W005/dockview-restricted', status: 'pass', detail: { constructError: null, moveError: null, componentSurvivedMove: true, added: ['probe-a'], maximize: { maximizedNodes: 1, restoredNodes: 0 }, dndCapabilities: { html5: true }, snapshotKeys: ['grid', 'panels'] } },
    ],
  }
  const passingResult = evaluate(passing.rows)
  console.log('self-test: a complete report')
  print(passing, passingResult.results, passingResult.blocking)
  check('complete report has no blocking criteria', passingResult.blocking.length === 0)
  const emptyResult = evaluate([])
  console.log('self-test: an empty report')
  check('empty report blocks on every critical criterion', emptyResult.blocking.length === CRITICAL.length)
  const stringy = evaluate(passing.rows.map((row) => ({ ...row, detail: JSON.stringify(row.detail) })))
  check('stringified details parse back', stringy.blocking.length === 0)
  console.log('')
  console.log(failures === 0 ? 'self-test passed' : 'self-test failed: ' + failures)
  process.exit(failures === 0 ? 0 : 2)
}

if (arg === undefined) {
  console.error('usage: node tools/p0-report.mjs <report.json> | --self-test')
  process.exit(2)
}

let report
try {
  report = parseReport(readFileSync(arg, 'utf8'))
} catch (error) {
  console.error('cannot read the report: ' + String(error.message ?? error))
  process.exit(2)
}

const { results, blocking } = evaluate(report.rows)
print(report, results, blocking)
process.exit(blocking.length === 0 ? 0 : 2)

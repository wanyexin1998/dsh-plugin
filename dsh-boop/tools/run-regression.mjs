#!/usr/bin/env node
/**
 * E07-01 · BOOP regression orchestrator.
 *
 * Groups the repository's checks so a failure in one group is never reported as
 * a failure of another (the issue explicitly forbids presenting offline
 * regressions as real-model failures and vice versa):
 *
 *   offline  tests/unit + tests/client        (no host, no model, always runs)
 *   host     hermetic host tests              (real rc.2.1 payload, isolated
 *                                              DSH_HOME per test; excludes the
 *                                              real-model opt-in files)
 *   real     opt-in real-model host tests     (runs ONLY when
 *                                              BOOP_QWEN_BASE_URL +
 *                                              BOOP_QWEN_MODEL are set; never
 *                                              faked, otherwise reported skipped)
 *
 * Every run records host/environment/git facts, the exact command per group, the
 * parsed pass/fail/skip counts, and the sanitized output tail into
 * `docs/development/evidence/e07-01/regression-<timestamp>.json`. The user's real
 * `~/.dsh` is never touched: every host test harness creates its own
 * `.work/test-runs/*` home.
 *
 * This tool is preparation for the final E07-01 gate evidence. It is NOT a
 * release certification; Desktop/Electron, browser screenshots, IME, and
 * macOS/Linux remain NOT_RUN regardless of a green local run.
 *
 * Usage:
 *   node tools/run-regression.mjs                          # all groups
 *   node tools/run-regression.mjs --only=offline           # unit+client only
 *   node tools/run-regression.mjs --only=host --host-filter=e07-01
 *   node tools/run-regression.mjs --list                   # plan, do not run
 *   node tools/run-regression.mjs --label=fault-baseline
 *
 * Options: --only=a,b  --host-filter=substr  --label=name  --out=path
 *          --no-evidence  --verbose  --list  --help
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EVIDENCE_DIR = path.join(PROJECT_ROOT, 'docs/development/evidence/e07-01')
const PAYLOAD_ROOT = process.env.DSH_PAYLOAD ?? path.join(PROJECT_ROOT, '.work/test-host/payload-0.2.1/dsh')
const NODE = process.execPath

const REAL_BASE_URL = process.env.BOOP_QWEN_BASE_URL?.trim() ?? ''
const REAL_MODEL = process.env.BOOP_QWEN_MODEL?.trim() ?? ''
const REAL_ENABLED = REAL_BASE_URL !== '' && REAL_MODEL !== ''

const GROUP_ORDER = ['offline', 'host', 'real']
const GROUP_TITLES = {
  offline: 'offline suite (unit + client; no host, no model)',
  host: 'host hermetic suite (real rc.2.1 payload; isolated DSH_HOME; excludes real-model files)',
  real: 'real-model opt-in suite (needs BOOP_QWEN_BASE_URL + BOOP_QWEN_MODEL; never faked)',
}
const TIMEOUTS = { offline: 600_000, host: 2_700_000, real: 900_000 }
const OUTPUT_LIMIT = 96 * 1024

/* ── CLI args ─────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const options = {
    only: null,
    hostFilter: '',
    label: '',
    out: '',
    evidence: true,
    verbose: false,
    list: false,
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--list') options.list = true
    else if (arg === '--no-evidence') options.evidence = false
    else if (arg === '--verbose') options.verbose = true
    else if (arg.startsWith('--only=')) options.only = arg.slice('--only='.length).split(',').map((name) => name.trim()).filter(Boolean)
    else if (arg.startsWith('--host-filter=')) options.hostFilter = arg.slice('--host-filter='.length)
    else if (arg.startsWith('--label=')) options.label = arg.slice('--label='.length)
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else throw new Error(`unknown argument: ${arg} (use --help)`)
  }
  if (options.only) {
    const unknown = options.only.filter((name) => !GROUP_ORDER.includes(name))
    if (unknown.length > 0) throw new Error(`unknown group(s) ${JSON.stringify(unknown)}; expected one of ${GROUP_ORDER.join(', ')}`)
    options.only = GROUP_ORDER.filter((name) => options.only.includes(name))
  }
  return options
}

function usage() {
  return `BOOP E07-01 regression orchestrator\n\n` +
    `  node tools/run-regression.mjs [options]\n\n` +
    `Groups (run in this order, independently reported):\n` +
    GROUP_ORDER.map((name) => `  ${name.padEnd(8)} ${GROUP_TITLES[name]}`).join('\n') +
    `\n\nOptions:\n` +
    `  --only=a,b             run only the named groups (offline,host,real)\n` +
    `  --host-filter=substr   only host test files whose name contains substr\n` +
    `  --label=name           label the evidence file (default: run)\n` +
    `  --out=path             evidence JSON path (default: docs/development/evidence/e07-01/regression-<ts>.json)\n` +
    `  --no-evidence          do not write an evidence JSON\n` +
    `  --verbose              print full group output tails\n` +
    `  --list                 print the planned commands and exit\n` +
    `  --help                 show this help\n`
}

/* ── discovery ────────────────────────────────────────────────────────── */

function listTestFiles(dir) {
  const absolute = path.join(PROJECT_ROOT, dir)
  if (!fs.existsSync(absolute)) return []
  return fs
    .readdirSync(absolute)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.posix.join(dir, name))
}

/** A host test is "real model opt-in" when its filename says so (e02-03/e05-00/e03-02). */
function isRealModelHostFile(file) {
  return /real/i.test(path.basename(file))
}

function buildPlan(options) {
  const unitFiles = listTestFiles('tests/unit')
  const clientFiles = listTestFiles('tests/client')
  const hostFiles = listTestFiles('tests/host')
  const hermeticHostFiles = hostFiles.filter((file) => !isRealModelHostFile(file))
  const realHostFiles = hostFiles.filter(isRealModelHostFile)
  const filteredHost = options.hostFilter === ''
    ? hermeticHostFiles
    : hermeticHostFiles.filter((file) => file.includes(options.hostFilter))

  return {
    offline: { files: [...unitFiles, ...clientFiles], command: [NODE, '--test', '--test-force-exit', ...unitFiles, ...clientFiles] },
    host: { files: filteredHost, command: [NODE, '--test', '--test-force-exit', '--test-concurrency=1', ...filteredHost] },
    real: { files: realHostFiles, command: [NODE, '--test', '--test-force-exit', '--test-concurrency=1', ...realHostFiles] },
  }
}

/* ── environment facts (sanitized) ────────────────────────────────────── */

function gitFacts() {
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : null
  }
  const head = run(['rev-parse', 'HEAD'])
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
  const status = run(['status', '--porcelain'])
  return {
    head,
    headShort: head === null ? null : head.slice(0, 7),
    branch,
    // The final gate evidence must name a clean candidate commit; a dirty tree is
    // recorded as a fact here instead of being hidden.
    dirty: status === null ? null : status.length > 0,
    dirtyEntries: status === null ? null : status.split('\n').filter(Boolean).length,
  }
}

function payloadFacts() {
  const manifestPath = path.join(PAYLOAD_ROOT, 'node_modules/@deepseek-ai/dsh/package.json')
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return { payloadRoot: PAYLOAD_ROOT, dshVersion: manifest.version, pinnedCommit: '332895e0f7c9d4dbfb29729f5eb367fa263ff986' }
  } catch (error) {
    return { payloadRoot: PAYLOAD_ROOT, dshVersion: null, pinnedCommit: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function environmentFacts() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: PROJECT_ROOT,
    isolatedDshHome: true,
    note: 'every host test creates its own DSH_HOME under .work/test-runs/; the user ~/.dsh is never read or modified',
    payload: payloadFacts(),
    realModel: {
      configured: REAL_ENABLED,
      // Never record the base URL value or any credential: only presence + model id.
      model: REAL_ENABLED ? REAL_MODEL : null,
      keyEnvPresent: Boolean(process.env.BOOP_QWEN_KEY),
      convention: 'BOOP_QWEN_BASE_URL + BOOP_QWEN_MODEL (same opt-in as E05-00/e02-03)',
    },
  }
}

/* ── execution ────────────────────────────────────────────────────────── */

function tail(text, limit = OUTPUT_LIMIT) {
  if (text.length <= limit) return text
  return `[… ${text.length - limit} bytes truncated …]\n` + text.slice(text.length - limit)
}

/**
 * Parse the test-runner summary. Node's default reporter writes either TAP
 * (`# tests 27`) or spec (`ℹ tests 27`) depending on the version/terminal; both
 * are accepted so the evidence always records real counts.
 */
function parseTestSummary(output) {
  const summary = {}
  const keys = ['tests', 'pass', 'fail', 'skipped', 'todo', 'duration_ms']
  for (const key of keys) {
    const matches = [...output.matchAll(new RegExp(`^(?:#|\\u2139)\\s+${key}\\s+(\\d+(?:\\.\\d+)?)$`, 'gmu'))]
    if (matches.length > 0) summary[key] = Number(matches[matches.length - 1][1])
  }
  return summary
}

function runGroup(name, plan, options) {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn(plan.command[0], plan.command.slice(1), {
      cwd: PROJECT_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.()
    }, TIMEOUTS[name])

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (options.verbose && process.stdout.isTTY) process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        exitCode: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        parsed: {},
        stdoutTail: tail(`spawn error: ${error instanceof Error ? error.message : String(error)}`),
        stderrTail: '',
      })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        exitCode: code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        parsed: parseTestSummary(stdout),
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr),
      })
    })
  })
}

function printGroupResult(name, result) {
  const parsed = result.parsed
  const counts = Object.keys(parsed).length === 0
    ? 'no test summary parsed'
    : `tests=${parsed.tests ?? '?'} pass=${parsed.pass ?? '?'} fail=${parsed.fail ?? '?'} skipped=${parsed.skipped ?? '?'}`
  const status = groupPassed(result) ? 'PASS' : result.timedOut ? 'TIMEOUT' : 'FAIL'
  console.log(`[${name}] ${status} — ${counts} — ${(result.durationMs / 1000).toFixed(1)}s (exit ${result.exitCode ?? 'null'}${result.signal ? `, signal ${result.signal}` : ''})`)
}

function groupPassed(result) {
  if (result.exitCode !== 0 || result.timedOut) return false
  const fail = result.parsed?.fail
  return fail === undefined || fail === 0
}

/* ── evidence ─────────────────────────────────────────────────────────── */

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function writeEvidence(payload, options, plan) {
  const file = options.out !== ''
    ? path.resolve(PROJECT_ROOT, options.out)
    : path.join(EVIDENCE_DIR, `regression-${timestampSlug()}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  return file
}

/* ── main ─────────────────────────────────────────────────────────────── */

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return 0
  }
  const plan = buildPlan(options)
  const selected = options.only ?? GROUP_ORDER

  if (options.list) {
    console.log(`BOOP E07-01 regression plan (${selected.join(', ')}):`)
    for (const name of selected) {
      const entry = plan[name]
      const enabled = name !== 'real' || REAL_ENABLED
      const reason = entry.files.length === 0
        ? 'no test files matched'
        : name === 'real' && !REAL_ENABLED
          ? 'set BOOP_QWEN_BASE_URL and BOOP_QWEN_MODEL to enable (never faked)'
          : null
      console.log(`\n[${name}] ${GROUP_TITLES[name]}`)
      console.log(`  enabled: ${enabled && reason === null}`)
      if (reason !== null) console.log(`  reason:  ${reason}`)
      console.log(`  files:   ${entry.files.length === 0 ? '(none)' : ''}`)
      for (const file of entry.files) console.log(`    - ${file}`)
      console.log(`  command: ${entry.command.slice(0, 3).join(' ')}${entry.files.length > 0 ? ' <files…>' : ''}`)
    }
    return 0
  }

  console.log(`BOOP E07-01 regression · ${new Date().toISOString()}`)
  console.log(`groups: ${selected.join(', ')}${options.hostFilter ? ` · host filter: ${options.hostFilter}` : ''}`)
  console.log(`real-model opt-in: ${REAL_ENABLED ? `ENABLED (${REAL_MODEL})` : 'DISABLED (set BOOP_QWEN_BASE_URL + BOOP_QWEN_MODEL; never faked)'}`)

  const groups = []
  const startedAt = Date.now()
  for (const name of selected) {
    const entry = plan[name]
    const skippedReason = entry.files.length === 0
      ? 'no test files matched'
      : name === 'real' && !REAL_ENABLED
        ? 'set BOOP_QWEN_BASE_URL and BOOP_QWEN_MODEL to run the real-model suite (opt-in; never faked)'
        : null

    if (skippedReason !== null) {
      groups.push({
        name,
        title: GROUP_TITLES[name],
        enabled: false,
        reason: skippedReason,
        files: entry.files,
        command: entry.command,
        result: null,
      })
      console.log(`[${name}] SKIPPED — ${skippedReason}`)
      continue
    }

    console.log(`[${name}] running ${entry.files.length} file(s)…`)
    const result = await runGroup(name, entry, options)
    groups.push({
      name,
      title: GROUP_TITLES[name],
      enabled: true,
      reason: null,
      files: entry.files,
      command: entry.command,
      result,
    })
    printGroupResult(name, result)
    if (!groupPassed(result)) {
      const tailLines = result.stdoutTail.split('\n').slice(-40).join('\n')
      console.log(`[${name}] failing tail:\n${tailLines}`)
      if (result.stderrTail.trim() !== '') console.log(`[${name}] stderr tail:\n${result.stderrTail.split('\n').slice(-20).join('\n')}`)
    }
  }

  const enabledGroups = groups.filter((group) => group.enabled)
  const failedGroups = enabledGroups.filter((group) => !groupPassed(group.result)).map((group) => group.name)
  const skippedGroups = groups.filter((group) => !group.enabled).map((group) => group.name)
  const overall = failedGroups.length > 0
    ? 'FAIL'
    : enabledGroups.length === 0
      ? 'SKIPPED'
      : skippedGroups.length > 0
        ? 'PASS_WITH_SKIPS'
        : 'PASS'

  const facts = {
    schemaVersion: 1,
    task: 'E07-01',
    product: 'BOOP',
    kind: 'regression-run',
    generatedAt: new Date().toISOString(),
    label: options.label || 'run',
    hostFilter: options.hostFilter || null,
    environment: environmentFacts(),
    git: gitFacts(),
    groups,
    overall: {
      status: overall,
      failedGroups,
      skippedGroups,
      durationMs: Date.now() - startedAt,
    },
    notRun: [
      'Desktop/Electron install & window controls',
      'browser screenshots (1280x800 / 1440x900 / 390x844, light/dark)',
      'IME / touch / screen-reader checks',
      'macOS / Linux compatibility',
      'IM channels (DingTalk/Feishu) — no credentials in this environment',
    ],
    note:
      'Local regression evidence only. A green run is NOT a release certification and does NOT ' +
      'replace the E07-01 gate evidence that requires real Desktop/browser environments.',
  }

  console.log(`\noverall: ${overall}${failedGroups.length > 0 ? ` (failed: ${failedGroups.join(', ')})` : ''}${skippedGroups.length > 0 ? ` (skipped: ${skippedGroups.join(', ')})` : ''}`)
  if (options.evidence) {
    const file = writeEvidence(facts, options, plan)
    console.log(`evidence: ${path.relative(PROJECT_ROOT, file).replace(/\\/g, '/')}`)
  } else {
    console.log('evidence: not written (--no-evidence)')
  }
  return overall === 'FAIL' ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`run-regression failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(2)
  })

/**
 * Build a local test payload from the INSTALLED DSH desktop app.
 *
 * The test suites never touch the user's real `~/.dsh`: they boot the installed
 * CLI against a private DSH_HOME. This script materializes that CLI (and its
 * dependencies) from `app.asar` plus the native modules in
 * `app.asar.unpacked`, so the tests exercise the exact shipped payload.
 *
 * Usage:
 *   node tools/build-test-payload.mjs [destDir]
 *
 * Defaults to `.work/test-host/payload` (what the harness reads unless
 * DSH_PAYLOAD overrides it). Pass a different dir to keep two versions side by
 * side, e.g. `.work/test-host/payload-0.2.1`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ASAR = process.env.DSH_ASAR ?? 'E:/deepseek-harness/resources/app.asar'
const UNPACKED = process.env.DSH_UNPACKED ?? 'E:/deepseek-harness/resources/app.asar.unpacked'
const dest = path.resolve(process.argv[2] ?? '.work/test-host/payload')

if (!fs.existsSync(ASAR)) {
  console.error(`asar not found: ${ASAR}`)
  process.exit(1)
}

const payload = path.join(dest, 'dsh')
console.log(`asar     : ${ASAR}`)
console.log(`unpacked : ${UNPACKED}`)
console.log(`dest     : ${payload}`)

if (fs.existsSync(payload)) {
  console.log('existing payload found — removing it first')
  fs.rmSync(payload, { recursive: true, force: true })
}
fs.mkdirSync(dest, { recursive: true })

console.log('extracting dsh tree from app.asar (this takes a while, ~400 MB)…')
execFileSync(
  process.execPath,
  [path.join('tools', 'inspect-asar.mjs'), '--extract', 'dsh', payload],
  { stdio: 'inherit' },
)

// Native modules (.node) live outside the asar because asar cannot dlopen them.
const unpackedDsh = path.join(UNPACKED, 'dsh')
if (fs.existsSync(unpackedDsh)) {
  console.log('overlaying app.asar.unpacked/dsh (native modules)…')
  fs.cpSync(unpackedDsh, payload, { recursive: true, force: true })
} else {
  console.log('warning: no app.asar.unpacked/dsh — native modules may be missing')
}

const versionFile = path.join(payload, 'node_modules/@deepseek-ai/dsh/package.json')
const version = fs.existsSync(versionFile)
  ? JSON.parse(fs.readFileSync(versionFile, 'utf8')).version
  : 'unknown'

const cli = path.join(payload, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
if (!fs.existsSync(cli)) {
  console.error(`CLI entry missing: ${cli}`)
  process.exit(1)
}

fs.writeFileSync(
  path.join(dest, 'payload.json'),
  JSON.stringify({ asar: ASAR, version, builtAt: new Date().toISOString(), cli }, null, 2),
)
console.log(`payload ready: dsh ${version}`)
console.log(`CLI: ${cli}`)
console.log(`Run the suites with: DSH_PAYLOAD="${payload}" node --test tests/host/*.test.mjs`)
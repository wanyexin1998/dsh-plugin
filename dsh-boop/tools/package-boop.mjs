#!/usr/bin/env node
/**
 * E07-02 · BOOP package builder + integrity verifier (read-only toward the repo).
 *
 * What it does, in order:
 *  1. `npm pack --dry-run --json` over the `files` whitelist and asserts the
 *     exact expected runtime entry set is present and no internal material /
 *     source / test bundle / lockfile leaked into the package;
 *  2. `npm pack --json` into an output directory (default `dist/`, ignored by
 *     git) — the ONLY file this tool creates besides its manifest JSON;
 *  3. decodes the produced `.tgz` itself (zlib + a minimal ustar/pax reader, no
 *     third-party dependency) and verifies every entry, size and sha256, the
 *     tar structure (all entries under `package/`), the npm-reported sha512
 *     integrity, and the expected `lib/` + `assets/3d/` completeness;
 *  4. writes `<out>/<name>-<version>.package.json` with the tarball sha256 and
 *     the full per-file list. A second run compares against the previous
 *     manifest and reports `reproducible: true|false` (deterministic tarballs
 *     are expected: npm normalizes mtimes and gzip mtime).
 *
 * It never publishes, never installs into a profile, never touches
 * `$DSH_HOME`, and never writes to the user's `~/.dsh`.
 *
 * Usage:
 *   node tools/package-boop.mjs [--out <dir>] [--json]
 *   npm run pack:verify
 *
 * Exit code 0 only when every check passed; any failure exits non-zero.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const NAME = String(PACKAGE_JSON.name)
const VERSION = String(PACKAGE_JSON.version)
const TARBALL_NAME = `${NAME}-${VERSION}.tgz`
const MANIFEST_NAME = `${NAME}-${VERSION}.package.json`

/* ── expected package contents (runtime only) ─────────────────────────── */

/**
 * Runtime files served by `src/host/assets.ts`; the host row reads them from
 * `<pkg>/assets/3d`, so a package without them breaks the 3D character.
 */
const ASSET_ENTRIES = [
  'assets/3d/boop.glb',
  'assets/3d/boop-assistant.js',
  'assets/3d/boop-assistant.d.ts',
  'assets/3d/README.md',
  'assets/3d/states/boop-idle-256.png',
  'assets/3d/states/boop-listen-256.png',
  'assets/3d/states/boop-think-256.png',
  'assets/3d/states/boop-success-256.png',
  'assets/3d/states/boop-error-256.png',
]

/**
 * Derive the required entry set from the repository itself instead of a frozen
 * hand list: the bundle patch names every host row's `./lib/*.js`, the export
 * map names the package entry points, and the client half is `lib/client.js`.
 * A newly added row therefore cannot silently ship without its module.
 */
function collectRequiredEntries() {
  const required = new Set([
    'package.json',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
    'NOTICE',
    'presets/boop.patch.yml',
    ...ASSET_ENTRIES,
  ])
  const patch = readFileSync(join(REPO_ROOT, 'cordis.patch.yml'), 'utf8')
  for (const match of patch.matchAll(/name:\s*'\.\/lib\/([^']+\.js)'/gu)) {
    required.add(`lib/${match[1]}`)
  }
  for (const value of Object.values(PACKAGE_JSON.exports ?? {})) {
    const target = typeof value === 'string' ? value : value?.default
    if (typeof target === 'string' && target.startsWith('./lib/')) required.add(target.slice(2))
  }
  required.add('lib/index.js')
  required.add('lib/client.js')
  return [...required].sort()
}

const REQUIRED_ENTRIES = collectRequiredEntries()

/** Paths/patterns that must NEVER ship: internal material, sources, tests, dev artifacts. */
const FORBIDDEN = [
  { label: 'source', test: (path) => /^(src|tests|tools|build\.mjs|tsconfig)\//.test(path) || path === 'build.mjs' || /^tests\//.test(path) },
  { label: 'internal docs/material', test: (path) => /^(docs|baseline|handoff|manifests|qa|demo|host-rc2|host-rc21)\//.test(path) },
  { label: 'internal delivery files', test: (path) => /BOOP_3D_Animation|BOOP_开发交接阅读器|README_开发团队先读|SHA256SUMS|pnpm-lock/.test(path) },
  { label: 'dev/test bundle', test: (path) => /\.test\.bundle\.cjs$/.test(path) },
  { label: 'build map / sourcemap / source', test: (path) => /\.map$/.test(path) || (/\.tsx?$/.test(path) && !/\.d\.ts$/.test(path)) },
  { label: 'archive/video/preview', test: (path) => /\.(zip|mp4|mov|blend|gltf)$/i.test(path) },
  { label: 'node_modules', test: (path) => /(^|\/)node_modules\//.test(path) },
  { label: 'repo-root-only file', test: (path) => /^(pnpm-workspace\.yaml|pnpm-lock\.yaml|tsconfig\.json|\.gitignore|\.npmignore)$/.test(path) },
  { label: 'hidden dot-file', test: (path) => /(^|\/)\./.test(path) },
  { label: 'root duplicate model', test: (path) => path === 'boop.glb' },
]

/* ── CLI arguments ────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)
const jsonMode = argv.includes('--json')
const outIndex = argv.indexOf('--out')
const outArg = outIndex >= 0 ? argv[outIndex + 1] : undefined
if (outIndex >= 0 && (!outArg || outArg.startsWith('--'))) {
  fail('--out needs a directory argument')
}
const OUT_DIR = outArg === undefined ? join(REPO_ROOT, 'dist') : (isAbsolute(outArg) ? outArg : resolve(REPO_ROOT, outArg))
const OUTSIDE_REPO = relative(REPO_ROOT, OUT_DIR).startsWith('..')

const failures = []
const notes = []
function fail(message) {
  failures.push(message)
  return undefined
}
function recordCheck(label, ok, detail) {
  if (!ok) failures.push(`${label}: ${detail ?? 'failed'}`)
  return ok
}
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}
function sha512Base64(buffer) {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`
}
function quoteShellArg(value) {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}
function runNpm(args) {
  const command = ['npm', ...args.map(quoteShellArg)].join(' ')
  const result = spawnSync(command, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, npm_config_update_notifier: 'false' },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw new Error(`cannot run npm: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
function parseJsonOutput(stdout, context) {
  const start = stdout.indexOf('[')
  const objectStart = stdout.indexOf('{')
  const from = start >= 0 && (objectStart < 0 || start < objectStart) ? start : objectStart
  if (from < 0) throw new Error(`${context}: npm produced no JSON output:\n${stdout}`)
  try {
    return JSON.parse(stdout.slice(from))
  } catch (error) {
    throw new Error(`${context}: cannot parse npm JSON (${error.message}):\n${stdout}`)
  }
}

/* ── minimal tar reader (ustar + pax long path; no dependencies) ──────── */

function cString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset)
  const stop = end === -1 || end > offset + length ? offset + length : end
  return buffer.subarray(offset, stop).toString('utf8')
}

/**
 * Parse an uncompressed tar buffer into entries.
 * Handles regular files ('0'/'\0'), directories ('5') and pax headers ('x'/'g').
 * Anything else is a structural failure for an npm package tarball.
 */
function parseTar(buffer) {
  const entries = []
  let pendingPaxPath = null
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = cString(header, 0, 100)
    const sizeField = cString(header, 124, 12).trim()
    const size = sizeField === '' ? 0 : Number.parseInt(sizeField, 8)
    if (!Number.isFinite(size) || size < 0) throw new Error(`tar: bad size for entry ${JSON.stringify(name)}`)
    const type = String.fromCharCode(header[156] || 48)
    const prefix = cString(header, 345, 155)
    const headerPath = prefix === '' ? name : `${prefix}/${name}`
    const dataStart = offset + 512
    const data = buffer.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512
    if (type === 'x' || type === 'g') {
      // pax extended header: read `path=` (and ignore other keys) for the next entry.
      const text = data.toString('utf8')
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)
      if (type === 'x' && match) pendingPaxPath = match[1]
      continue
    }
    const path = pendingPaxPath ?? headerPath
    pendingPaxPath = null
    if (type === '0' || type === '\0') {
      entries.push({ path, type: 'file', size, data })
    } else if (type === '5') {
      entries.push({ path, type: 'directory', size: 0, data: Buffer.alloc(0) })
    } else {
      throw new Error(`tar: unsupported entry type ${JSON.stringify(type)} for ${JSON.stringify(path)}`)
    }
  }
  return entries
}

/* ── main ─────────────────────────────────────────────────────────────── */

try {
  if (OUTSIDE_REPO) {
    // The tool may write only inside the repo checkout (never near $DSH_HOME).
    throw new Error(`--out must stay inside the repository checkout (got ${OUT_DIR})`)
  }
  mkdirSync(OUT_DIR, { recursive: true })
  // Read the previous manifest BEFORE cleaning: a second run compares its
  // tarball bytes with this one to prove the package is reproducible.
  const previousManifestPath = join(OUT_DIR, MANIFEST_NAME)
  const previousManifest = existsSync(previousManifestPath)
    ? JSON.parse(readFileSync(previousManifestPath, 'utf8'))
    : null
  for (const file of [TARBALL_NAME, MANIFEST_NAME]) {
    const stale = join(OUT_DIR, file)
    if (existsSync(stale)) rmSync(stale, { force: true })
  }

  /* ── stage 1: dry-run over the files whitelist ─────────────────────── */
  const dryRun = parseJsonOutput(
    runNpm(['pack', '--dry-run', '--json', '--ignore-scripts', '--pack-destination', OUT_DIR]).stdout,
    'npm pack --dry-run',
  )
  const dryEntry = Array.isArray(dryRun) ? dryRun[0] : dryRun
  if (!dryEntry || typeof dryEntry !== 'object') throw new Error('npm pack --dry-run returned no package metadata')
  const dryFiles = (dryEntry.files ?? []).map((file) => String(file.path).replace(/\\/g, '/'))
  recordCheck('dry-run file list is non-empty', dryFiles.length > 0, 'npm reported no files')
  const drySet = new Set(dryFiles)
  for (const required of REQUIRED_ENTRIES) {
    recordCheck(`dry-run has ${required}`, drySet.has(required), 'missing from the npm pack list')
  }
  const leaked = dryFiles.filter((path) => FORBIDDEN.some((rule) => rule.test(path)))
  recordCheck('dry-run has no forbidden entries', leaked.length === 0, leaked.join(', '))
  recordCheck(
    'dry-run has no test bundles',
    !dryFiles.some((path) => /\.test\.bundle\.cjs$/.test(path)),
    dryFiles.filter((path) => /\.test\.bundle\.cjs$/.test(path)).join(', '),
  )
  const unexpected = dryFiles.filter((path) => !REQUIRED_ENTRIES.includes(path))
  if (unexpected.length > 0) {
    // Extra files are allowed only if they are not forbidden; report them so the
    // manifest documents the real package rather than an assumed one.
    notes.push(`extra packaged entries: ${unexpected.join(', ')}`)
  }

  /* ── stage 2: real pack → tarball ──────────────────────────────────── */
  const packed = parseJsonOutput(
    runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', OUT_DIR]).stdout,
    'npm pack',
  )
  const packedEntry = Array.isArray(packed) ? packed[0] : packed
  if (!packedEntry || typeof packedEntry !== 'object') throw new Error('npm pack returned no package metadata')
  const tarballPath = join(OUT_DIR, String(packedEntry.filename ?? TARBALL_NAME))
  if (!existsSync(tarballPath)) throw new Error(`npm pack did not create ${tarballPath}`)
  const tarball = readFileSync(tarballPath)
  const tarballSha256 = sha256(tarball)
  const reportedIntegrity = typeof packedEntry.integrity === 'string' ? packedEntry.integrity : null
  if (reportedIntegrity !== null) {
    recordCheck('npm sha512 integrity matches the tarball bytes', sha512Base64(tarball) === reportedIntegrity, reportedIntegrity)
  }
  recordCheck('tarball filename matches package name/version', tarballPath.endsWith(TARBALL_NAME), tarballPath)
  recordCheck(
    'tarball byte size matches npm metadata',
    Number(packedEntry.size) === tarball.length,
    `${packedEntry.size} vs ${tarball.length}`,
  )

  /* ── stage 3: decode the tarball and verify the real entries ────────── */
  const tarBuffer = gunzipSync(tarball)
  const entries = parseTar(tarBuffer)
  const fileEntries = entries.filter((entry) => entry.type === 'file')
  const files = fileEntries.map((entry) => ({
    path: entry.path.replace(/^package\//, ''),
    bytes: entry.size,
    sha256: sha256(entry.data),
  }))
  // Sort once, before the reproducibility comparison: the next run must be
  // compared against the same deterministic order the manifest records.
  files.sort((left, right) => left.path.localeCompare(right.path))
  const byPath = new Map(files.map((file) => [file.path, file]))
  recordCheck(
    'every tar entry lives under package/',
    entries.every((entry) => entry.path === 'package' || entry.path.startsWith('package/')),
    entries.filter((entry) => !entry.path.startsWith('package/')).map((entry) => entry.path).join(', '),
  )
  for (const required of REQUIRED_ENTRIES) {
    recordCheck(`tarball contains ${required}`, byPath.has(required), 'missing from the actual tarball')
  }
  const tarLeaked = files.filter((file) => FORBIDDEN.some((rule) => rule.test(file.path)))
  recordCheck('tarball has no forbidden entries', tarLeaked.length === 0, tarLeaked.map((file) => file.path).join(', '))
  recordCheck(
    'tarball file set matches the dry-run file set',
    files.length === dryFiles.length && files.every((file) => drySet.has(file.path)),
    `${files.length} tar entries vs ${dryFiles.length} dry-run entries`,
  )
  const glb = byPath.get('assets/3d/boop.glb')
  recordCheck('3D model is the expected real GLB size', glb !== undefined && glb.bytes > 1_000_000, glb ? `${glb.bytes} bytes` : 'missing')
  recordCheck(
    'client bundle is present and non-trivial',
    (byPath.get('lib/client.js')?.bytes ?? 0) > 20_000,
    'lib/client.js is missing or empty',
  )

  /* ── stage 4: deterministic-byte evidence for a second run ─────────── */
  let reproducible = null
  if (previousManifest !== null && previousManifest?.tarball?.sha256) {
    reproducible =
      previousManifest.tarball.sha256 === tarballSha256 &&
      JSON.stringify(previousManifest.files ?? []) === JSON.stringify(files)
  }

  const manifest = {
    schemaVersion: 1,
    tool: 'tools/package-boop.mjs',
    generatedFor: 'E07-02',
    generatedAt: new Date().toISOString(),
    command: 'npm pack --json --ignore-scripts --pack-destination <out>',
    environment: {
      node: process.version,
      npm: runNpm(['--version']).stdout.trim(),
      platform: process.platform,
      arch: process.arch,
    },
    package: {
      name: NAME,
      version: VERSION,
      license: PACKAGE_JSON.license ?? null,
      private: PACKAGE_JSON.private === true,
      engines: PACKAGE_JSON.engines ?? null,
      peerDependencies: PACKAGE_JSON.peerDependencies ?? {},
    },
    tarball: {
      filename: TARBALL_NAME,
      bytes: tarball.length,
      sha256: tarballSha256,
      sha512Integrity: reportedIntegrity,
      unpackedBytes: Number(packedEntry.unpackedSize ?? tarBuffer.length),
      fileCount: files.length,
    },
    files,
    checks: {
      dryRunEntries: dryFiles.length,
      requiredEntries: REQUIRED_ENTRIES.length,
      requiredComplete: REQUIRED_ENTRIES.every((required) => byPath.has(required)),
      forbiddenAbsent: tarLeaked.length === 0 && leaked.length === 0,
      testBundlesAbsent: !files.some((file) => /\.test\.bundle\.cjs$/.test(file.path)),
      allEntriesUnderPackageDir: entries.every((entry) => entry.path.startsWith('package/')),
      integrityVerified: reportedIntegrity === null ? true : sha512Base64(tarball) === reportedIntegrity,
      reproducible,
      extraEntries: unexpected,
      notes,
    },
    notVerified: [
      'real install into a user profile (runbook steps only; NOT_RUN pending E07-01)',
      'upgrade/rollback drill on a real profile (NOT_RUN)',
      'DSH Desktop Electron install/UI (NOT_RUN)',
      'public registry / marketplace publication (not requested)',
      'macOS/Linux packaging and install (NOT_RUN; not claimed)',
    ],
  }
  writeFileSync(join(OUT_DIR, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const summary = {
    ok: failures.length === 0,
    tarball: tarballPath,
    tarballSha256,
    files: files.length,
    unpackedBytes: manifest.tarball.unpackedBytes,
    reproducible,
    manifest: join(OUT_DIR, MANIFEST_NAME),
    failures,
    notes,
  }
  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(`BOOP package: ${TARBALL_NAME}`)
    console.log(`  sha256      : ${tarballSha256}`)
    console.log(`  files       : ${files.length} (unpacked ${manifest.tarball.unpackedBytes} bytes)`)
    console.log(`  manifest    : ${relative(REPO_ROOT, join(OUT_DIR, MANIFEST_NAME))}`)
    if (reproducible !== null) console.log(`  reproducible: ${reproducible} (compared with the previous manifest)`)
    for (const note of notes) console.log(`  note        : ${note}`)
    for (const message of failures) console.log(`  FAIL        : ${message}`)
    if (failures.length === 0) console.log('OK: the runtime package is complete and contains no internal material.')
  }
  if (failures.length > 0) process.exitCode = 1
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (jsonMode) console.log(JSON.stringify({ ok: false, error: message, failures }))
  else console.error(`package-boop: FAILED — ${message}`)
  process.exitCode = 1
}

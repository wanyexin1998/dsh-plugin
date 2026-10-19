#!/usr/bin/env node
/**
 * E07-02 · isolated install / upgrade / uninstall rehearsal from the built tarball.
 *
 * Installs the packaged `dist/dsh-boop-<version>.tgz` into a PRIVATE profile in a
 * disposable `$DSH_HOME` (never the user's `~/.dsh`), boots the real shipped
 * DSH 0.2.1-rc.2 CLI, checks the BOOP rows/API/assets are live, re-installs the
 * same tarball as an upgrade rehearsal, then removes the bundle and checks the
 * BOOP endpoints disappear while the ledger data stays on disk.
 *
 * This is the "install path" evidence E07-02 needs before a real user profile is
 * touched. It never writes the user's profile and never needs the model service.
 *
 * Usage:
 *   node tools/rehearse-install.mjs [--tarball <path>] [--out <dir>]
 * Exit code 0 only when every stage passed.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASAR = process.env.DSH_ASAR ?? 'E:/deepseek-harness/resources/app.asar'
const PAYLOAD =
  process.env.DSH_PAYLOAD ?? path.join(ROOT, '.work/test-host/payload-0.2.1/dsh')
const NODE_BIN =
  process.env.DSH_NODE ??
  'C:/Users/wanyexin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
const PNPM_BIN = path.resolve(path.dirname(NODE_BIN), '..', 'pnpm/bin/pnpm.cjs')
const CLI = path.join(PAYLOAD, 'node_modules/@deepseek-ai/dsh/lib/bin.js')

const args = process.argv.slice(2)
function flag(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const tarball = path.resolve(flag('--tarball', path.join(ROOT, 'dist', `${pkg.name}-${pkg.version}.tgz`)))
const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const OUT = path.resolve(flag('--out', path.join(ROOT, 'docs/development/evidence/e07-02')))
const WORK = path.join(ROOT, '.work/test-runs/e07-02-rehearsal-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const PROFILE = 'boop-install'
const PROFILE_DIR = path.join(HOME, 'profiles', PROFILE)

const stages = []
function stage(name, ok, detail) {
  stages.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) throw new Error(`stage failed: ${name}: ${detail}`)
}

function runCli(cliArgs, timeoutMs = 240_000) {
  return spawnSync(NODE_BIN, [CLI, ...cliArgs], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: HOME },
    encoding: 'utf8',
    timeout: timeoutMs,
  })
}

function pnpm(runArgs, cwd) {
  const result = spawnSync(NODE_BIN, [PNPM_BIN, ...runArgs], { cwd, encoding: 'utf8', timeout: 300_000 })
  return result
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function boot(port) {
  const child = spawn(NODE_BIN, [CLI, '--profile', PROFILE, '--no-open', '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (chunk) => (out += chunk))
  child.stderr.on('data', (chunk) => (err += chunk))
  const started = Date.now()
  while (Date.now() - started < 240_000) {
    const match = /dsh web: (\S+)/u.exec(out + err)
    if (match) {
      return {
        child,
        url: match[1],
        out,
        err,
        async stop() {
          if (child.exitCode !== null) return
          child.kill('SIGTERM')
          await new Promise((resolve) => child.once('exit', resolve))
        },
      }
    }
    if (child.exitCode !== null) throw new Error(`web exited early (${child.exitCode})\n${out}\n${err}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  child.kill('SIGTERM')
  throw new Error(`web boot timed out\n${out}\n${err}`)
}

async function authorizeExact(url) {
  // Fetch the printed launch URL EXACTLY as emitted: re-encoding a token that
  // contains `+` would turn it into a space and the Host would answer 400.
  const response = await fetch(url, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  if (!setCookie) {
    let body = ''
    try {
      body = (await response.text()).slice(0, 300)
    } catch {
      /* ignore */
    }
    throw new Error(`no cookie granted (status ${response.status}; body=${body})`)
  }
  return setCookie.split(';')[0]
}

async function rpc(base, cookie, endpoint) {
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `rehearse-${Math.random().toString(16).slice(2)}`, method: endpoint, payload: { args: {} } }),
  })
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  return { status: response.status, body }
}

async function bootAndProbe(label) {
  const port = await freePort()
  const host = await boot(port)
  try {
    const cookie = await authorizeExact(host.url)
    const base = host.url.split('?')[0].replace(/\/+$/u, '')
    const bootstrap = await rpc(base, cookie, 'boop/bootstrap')
    const model = await fetch(`${base}/api/boop/model.glb`, { headers: { cookie } })
    stage(`${label}: BOOP rows load and /api/boop/bootstrap answers`, bootstrap.status === 200 && bootstrap.body?.result?.ok === true,
      `HTTP ${bootstrap.status}; scope=${bootstrap.body?.result?.value?.scope?.dshProfileVersion ?? 'n/a'}`)
    stage(`${label}: packaged 3D asset route serves the shipped GLB`, model.status === 200, `HTTP ${model.status}`)
    stage(`${label}: gate ledger still keeps write mode OFF`, bootstrap.body?.result?.value?.writeMode?.enabled === false,
      `blockedBy=${(bootstrap.body?.result?.value?.writeMode?.blockedByGates ?? []).join(',')}`)
  } finally {
    await host.stop()
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(HOME, { recursive: true })
  stage('tarball exists', fs.existsSync(tarball), tarball)

  // Initialize the private profile from the shipped `web` template first: the
  // CLI's first-use profile is intentionally minimal, and a real install targets
  // a composed web/desktop profile (dsh-base -> dsh-web-app -> plugin bundle).
  const initProfile = runCli(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'])
  stage('initialize a private web profile', initProfile.status === 0 && fs.existsSync(PROFILE_DIR),
    (initProfile.stderr || '').slice(-600))

  const init = runCli(['plugin', '--profile', PROFILE, 'add', tarball])
  if (init.status !== 0) {
    stage('install the tarball into a private profile', false, (init.stderr || init.stdout || '').slice(-1200))
  }
  const installed = path.join(PROFILE_DIR, 'node_modules', 'dsh-boop', 'package.json')
  stage('install the tarball into a private profile', fs.existsSync(installed), PROFILE_DIR)
  const installedPkg = JSON.parse(fs.readFileSync(installed, 'utf8'))
  stage('installed package version matches the tarball', installedPkg.version === pkg.version, installedPkg.version)
  for (const entry of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'assets/3d/boop.glb']) {
    stage(`installed package contains ${entry}`, fs.existsSync(path.join(PROFILE_DIR, 'node_modules', 'dsh-boop', entry)))
  }

  // Enable the bundle in this private profile (normal profile composition).
  const manifestPath = path.join(PROFILE_DIR, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.dsh ??= { profile: {} }
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles = [...new Set([...(manifest.dsh.profile.bundles ?? []), 'dsh-boop'])]
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  await bootAndProbe('fresh install')

  const ledger = path.join(HOME, 'boop', 'boop.sqlite')
  stage('fresh install opened the BOOP ledger under the private DSH_HOME', fs.existsSync(ledger), ledger)
  const scopeBefore = (() => {
    try {
      return fs.statSync(ledger).size
    } catch {
      return -1
    }
  })()

  // Upgrade rehearsal: reinstall the SAME packaged version over itself (the
  // available upgrade primitive today is "install a tarball again"). A true
  // version-to-version upgrade needs a second package build; that stays NOT_RUN.
  const reinstall = runCli(['plugin', '--profile', PROFILE, 'add', tarball])
  stage('reinstall the same tarball (upgrade primitive) succeeds', reinstall.status === 0, (reinstall.stderr || '').slice(-400))
  await bootAndProbe('reinstall')

  // Uninstall rehearsal: stop the bundle, keep user data.
  const remove = runCli(['plugin', '--profile', PROFILE, 'remove', 'dsh-boop'])
  stage('remove the bundle from the private profile', remove.status === 0, (remove.stderr || '').slice(-400))
  const manifestAfter = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifestAfter.dsh.profile.bundles = (manifestAfter.dsh.profile.bundles ?? []).filter((name) => name !== 'dsh-boop')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifestAfter, null, 2)}\n`)

  const port = await freePort()
  const host = await boot(port)
  try {
    const base = host.url.split('?')[0].replace(/\/+$/u, '')
    const cookie = await authorizeExact(host.url)
    const gone = await rpc(base, cookie, 'boop/bootstrap')
    stage('after uninstall the BOOP endpoint is gone (404)', gone.status === 404, `HTTP ${gone.status}`)
  } finally {
    await host.stop()
  }
  stage('uninstall keeps the BOOP ledger file (no user data deleted)', fs.existsSync(ledger), ledger)
  stage('uninstall keeps the ledger size stable', fs.statSync(ledger).size >= scopeBefore, `${scopeBefore} -> ${fs.statSync(ledger).size}`)

  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    host: { payload: PAYLOAD, dshHome: HOME, profile: PROFILE },
    tarball: { path: tarball, bytes: fs.statSync(tarball).size },
    note: 'exported data dirs (ledger) are kept on uninstall; a true version-to-version upgrade rehearsal still needs a second built version (NOT_RUN)',
    stages,
  }
  const target = path.join(OUT, `install-rehearsal-${stamp}.json`)
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`PASS ${stages.length} stages — evidence: ${target}`)
}

main().catch((error) => {
  console.error(`REHEARSAL FAILED: ${String(error)}`)
  const report = { schemaVersion: 1, capturedAt: new Date().toISOString(), failed: String(error), stages }
  try {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, `install-rehearsal-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`)
  } catch {
    /* evidence write is best effort on failure */
  }
  process.exit(1)
})

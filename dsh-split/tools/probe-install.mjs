#!/usr/bin/env node
/**
 * Safe install/uninstall for a client-only bundle in the DSH desktop profile.
 *
 * Written after the 2026-10-15 incident (docs/evidence/incident-20261015-probe-web-boot.md):
 * adding a bundle to a profile without validating its client artifact kept the whole
 * window from opening. This script therefore
 *
 *   1. validates the artifact with tools/check-client-bundle.mjs and REFUSES to
 *      install when the guard fails (no wrapper, ESM-shaped, or bundled React);
 *   2. never writes unless `--yes` is passed — the default is a read-only plan;
 *   3. backs up `package.json` before touching it, and prints the exact rollback path;
 *   4. never restarts DSH. Restarting is the user's call, always.
 *
 * Usage:
 *   node tools/probe-install.mjs --check
 *   node tools/probe-install.mjs --install --yes
 *   node tools/probe-install.mjs --uninstall --yes
 * Options: --profile <dir> (default ~/.dsh/profiles/desktop), --package <dir> (default ./probe)
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index === -1 || args[index + 1] === undefined ? fallback : args[index + 1]
}

const mode = has('--install') ? 'install' : has('--uninstall') ? 'uninstall' : 'check'
const confirmed = has('--yes')
const profileDir = resolve(valueOf('--profile', join(homedir(), '.dsh', 'profiles', 'desktop')))
const packageDir = resolve(valueOf('--package', join(repo, 'probe')))

const packageJsonPath = join(profileDir, 'package.json')
const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const moduleId = pkg.name
const entryFields = Object.keys(pkg.exports ?? {})
const isClientOnly = entryFields.includes('./client')

function guardArtifact() {
  const artifact = join(packageDir, 'lib', 'client.js')
  if (!existsSync(artifact)) return { ok: false, note: 'missing ' + artifact }
  try {
    const output = execFileSync(process.execPath, [join(repo, 'tools', 'check-client-bundle.mjs'), artifact, moduleId], { encoding: 'utf8' })
    return { ok: true, note: output.trim().split('\n').slice(-1)[0] ?? '' }
  } catch (error) {
    return { ok: false, note: String(error.stdout ?? error.message ?? error).trim() }
  }
}

function readProfile() {
  if (!existsSync(packageJsonPath)) throw new Error('profile not found: ' + packageJsonPath)
  return JSON.parse(readFileSync(packageJsonPath, 'utf8'))
}

function plan(profile) {
  const hasDependency = profile.dependencies !== undefined && profile.dependencies[moduleId] !== undefined
  const bundles = profile.dsh?.profile?.bundles ?? []
  const hasBundle = bundles.includes(moduleId)
  const linkPath = join(profileDir, 'node_modules', moduleId)
  const hasLink = existsSync(linkPath)
  return { hasDependency, hasBundle, hasLink, linkPath }
}

const guard = guardArtifact()
const profile = readProfile()
const state = plan(profile)

console.log('profile      : ' + profileDir)
console.log('package      : ' + packageDir + '  (' + moduleId + ')')
console.log('client-only  : ' + String(isClientOnly))
console.log('artifact     : ' + (guard.ok ? 'PASS — ' + guard.note : 'FAIL — ' + guard.note))
console.log('current state: dependency=' + state.hasDependency + ' bundle=' + state.hasBundle + ' link=' + state.hasLink)
console.log('')

if (mode === 'check') {
  console.log('plan (no writes):')
  if (state.hasDependency && state.hasBundle && state.hasLink) console.log('  already installed; `--uninstall --yes` would remove it')
  else console.log('  `--install --yes` would: back up package.json, add dependencies["' + moduleId + '"], append to dsh.profile.bundles, create the node_modules link')
  console.log('  after any install/uninstall: restart DSH yourself (this script never restarts it)')
  process.exit(guard.ok || state.hasBundle ? 0 : 2)
}

if (!confirmed) {
  console.error('refusing to write without --yes (run --check first to see the plan)')
  process.exit(2)
}

if (mode === 'install' && !guard.ok) {
  console.error('refusing to install: the client artifact failed the guard')
  console.error(guard.note)
  process.exit(2)
}

if (mode === 'install' && !isClientOnly) {
  console.error('refusing to install: this installer only handles client-only bundles (exports["./client"])')
  process.exit(2)
}

if (mode === 'install') {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17)
  const backup = packageJsonPath + '.bak-install-' + stamp
  cpSync(packageJsonPath, backup)
  console.log('backup       : ' + backup)

  if (!state.hasDependency) {
    profile.dependencies = { ...(profile.dependencies ?? {}), [moduleId]: 'link:' + packageDir.replace(/\\/g, '/') }
  }
  const bundles = profile.dsh?.profile?.bundles ?? []
  if (!state.hasBundle) {
    profile.dsh = profile.dsh ?? {}
    profile.dsh.profile = profile.dsh.profile ?? {}
    profile.dsh.profile.bundles = [...bundles, moduleId]
  }
  writeFileSync(packageJsonPath, JSON.stringify(profile, null, 2) + '\n')
  JSON.parse(readFileSync(packageJsonPath, 'utf8')) /* re-parse to prove it is still valid */

  if (!state.hasLink) {
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    // Junction on Windows (directory links need no elevation); symlink elsewhere.
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', state.linkPath, packageDir], { stdio: 'inherit' })
    } else {
      symlinkSync(packageDir, state.linkPath, 'dir')
    }
  }
  console.log('installed    : ' + moduleId)
  console.log('rollback     : restore ' + backup + ' and delete ' + state.linkPath)
  console.log('next         : restart DSH yourself — this script never restarts it')
} else {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17)
  const backup = packageJsonPath + '.bak-install-' + stamp
  cpSync(packageJsonPath, backup)
  console.log('backup       : ' + backup)

  if (profile.dependencies !== undefined) delete profile.dependencies[moduleId]
  if (profile.dsh?.profile?.bundles !== undefined) {
    profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter((name) => name !== moduleId)
  }
  writeFileSync(packageJsonPath, JSON.stringify(profile, null, 2) + '\n')
  JSON.parse(readFileSync(packageJsonPath, 'utf8'))

  if (state.hasLink) {
    unlinkSync(state.linkPath)
  }
  console.log('uninstalled  : ' + moduleId)
  console.log('rollback     : restore ' + backup)
  console.log('next         : restart DSH yourself — this script never restarts it')
}

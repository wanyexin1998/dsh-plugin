#!/usr/bin/env node
/**
 * Workbench installer (dry-run by default; never restarts anything).
 *
 * What an install does — and why each step is mandatory:
 *   1. validate `dist/client.js` with tools/check-client-bundle.mjs. A client half without
 *      the module-loader wrapper, or without its `inject` declaration, fails ACTIVATION and
 *      blocks web boot entirely (docs/evidence/incident-20261015-probe-web-boot.md).
 *   2. back up the current `lib/` artifacts, then copy `dist/` over them. `lib/` is the swap
 *      point: while only `dist/` changes, the installed plugin keeps its previous artifact.
 *   3. link the patched host packages into the profile under their ORIGINAL scoped names
 *      (M-A1), then extend this bundle's `cordis.patch.yml` with disable+insert rows so the
 *      loader picks the patched copies instead of the shipped ones.
 *   4. print the exact rollback paths. Restarting is the user's call, always.
 *
 * Usage:
 *   node tools/workbench-install.mjs --check
 *   node tools/workbench-install.mjs --install --yes [--patches]
 *   node tools/workbench-install.mjs --uninstall --yes
 * Options: --profile <dir>, --repo <dir>
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
const withPatches = has('--patches')
const profileDir = resolve(valueOf('--profile', join(homedir(), '.dsh', 'profiles', 'desktop')))
const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17)

/** The patched host packages, by their original scoped specifier. */
const PATCHED = [
  { name: '@deepseek-ai/dsh-client-ui-sidebar-right', rowId: 'ui-sidebar-right' },
  { name: '@deepseek-ai/dsh-client-ui-workspace', rowId: 'ui-workspace' },
  { name: '@deepseek-ai/dsh-client-ui-attachment', rowId: 'ui-attachment' },
]

const PATCH_MARKER = '# ── contract patches (written by tools/workbench-install.mjs) ──'

const pluginPatchPath = join(repo, 'cordis.patch.yml')
// Idempotent: drop any previously written contract-patch rows before re-appending.
const plainPatch = readFileSync(pluginPatchPath, 'utf8').split(PATCH_MARKER)[0]

function guardDist() {
  const artifact = join(repo, 'dist', 'client.js')
  if (!existsSync(artifact)) return { ok: false, note: 'missing ' + artifact + ' (run node build.mjs)' }
  try {
    const output = execFileSync(process.execPath, [join(repo, 'tools', 'check-client-bundle.mjs'), artifact, 'dsh-split'], { encoding: 'utf8' })
    const verdict = output.split('\n').filter((line) => line.includes('→')).pop() ?? ''
    return { ok: true, note: verdict.trim() }
  } catch (error) {
    return { ok: false, note: String(error.stdout ?? error.message ?? error) }
  }
}

function patchDirs() {
  return PATCHED.map((entry) => ({
    ...entry,
    dir: join(repo, 'patches', 'patched', entry.name.replace('@deepseek-ai/', '')),
    link: join(profileDir, 'node_modules', entry.name),
  }))
}

const guard = guardDist()
const dirs = patchDirs()
const linksPresent = dirs.filter((entry) => existsSync(entry.link)).length

console.log('repo        : ' + repo)
console.log('profile     : ' + profileDir)
console.log('artifact    : ' + (guard.ok ? 'PASS — ' + guard.note : 'FAIL — ' + guard.note))
console.log('lib/ present: ' + existsSync(join(repo, 'lib', 'client.js')))
console.log('patched dirs: ' + dirs.filter((entry) => existsSync(join(entry.dir, 'lib', 'client.js'))).length + '/' + dirs.length)
console.log('profile links: ' + linksPresent + '/' + dirs.length)
console.log('')

if (mode === 'check') {
  console.log('plan (no writes):')
  console.log('  1. verify the guard (done above) and back up lib/ → lib.bak-install-' + stamp)
  console.log('  2. copy dist/client.js → lib/client.js, dist/index.js → lib/index.js')
  console.log('  3. ' + (withPatches ? 'link the 3 patched packages into the profile + write the contract-patch rows' : 'skip contract patches (pass --patches to include them)'))
  console.log('  4. you restart DSH yourself; rollback paths are printed on install')
  process.exit(guard.ok ? 0 : 2)
}

if (!confirmed) {
  console.error('refusing to write without --yes (run --check first)')
  process.exit(2)
}

if (mode === 'install' && !guard.ok) {
  console.error('refusing to install: the client artifact failed the guard')
  console.error(guard.note)
  process.exit(2)
}

if (mode === 'install') {
  /* 1–2. swap the artifacts, keeping the previous ones */
  const libBackup = join(repo, 'lib.bak-install-' + stamp)
  if (existsSync(join(repo, 'lib'))) {
    cpSync(join(repo, 'lib'), libBackup, { recursive: true })
    console.log('lib backup  : ' + libBackup)
  }
  mkdirSync(join(repo, 'lib'), { recursive: true })
  cpSync(join(repo, 'dist', 'client.js'), join(repo, 'lib', 'client.js'))
  cpSync(join(repo, 'dist', 'index.js'), join(repo, 'lib', 'index.js'))
  console.log('artifacts   : dist/ → lib/ copied')

  /* 2b. the profile must list this bundle, otherwise the swap is invisible at runtime */
  const profileJsonPath = join(profileDir, 'package.json')
  const profileJson = JSON.parse(readFileSync(profileJsonPath, 'utf8'))
  const bundles = profileJson.dsh?.profile?.bundles ?? []
  if (!bundles.includes('dsh-split')) {
    cpSync(profileJsonPath, profileJsonPath + '.bak-install-' + stamp)
    profileJson.dsh = profileJson.dsh ?? {}
    profileJson.dsh.profile = profileJson.dsh.profile ?? {}
    profileJson.dsh.profile.bundles = [...bundles, 'dsh-split']
    writeFileSync(profileJsonPath, JSON.stringify(profileJson, null, 2) + '\n')
    JSON.parse(readFileSync(profileJsonPath, 'utf8'))
    console.log('profile     : dsh-split added to dsh.profile.bundles (backup: package.json.bak-install-' + stamp + ')')
  } else {
    console.log('profile     : dsh-split already listed in dsh.profile.bundles')
  }

  /* 3. contract patches */
  if (withPatches) {
    for (const entry of dirs) {
      if (!existsSync(join(entry.dir, 'lib', 'client.js'))) {
        console.error('refusing: patched package missing for ' + entry.name)
        process.exit(2)
      }
      if (existsSync(entry.link)) {
        try {
          unlinkSync(entry.link)
        } catch (error) {
          try {
            rmSync(entry.link, { recursive: false, force: true })
          } catch (second) {
            console.error('unlink failed: ' + entry.name + ' — ' + String(second.message ?? second))
          }
        }
      }
      mkdirSync(join(profileDir, 'node_modules', '@deepseek-ai'), { recursive: true })
      if (process.platform === 'win32') {
        execFileSync('cmd', ['/c', 'mklink', '/J', entry.link, entry.dir], { stdio: 'inherit' })
      } else {
        symlinkSync(entry.dir, entry.link, 'dir')
      }
      console.log('linked      : ' + entry.name + ' → ' + entry.dir)
    }
    const rows = [
      '',
      PATCH_MARKER,
      ...PATCHED.map((entry) => '- id: ' + entry.rowId + '\n  disabled: true'),
      '- insert:',
      ...PATCHED.map((entry) => "    - id: dsh-patch-" + entry.rowId + "\n      name: '" + entry.name + "'"),
      '',
    ].join('\n')
    writeFileSync(pluginPatchPath, plainPatch.trimEnd() + '\n' + rows)
    console.log('patch rows  : ' + pluginPatchPath + ' extended (disable + insert ×' + PATCHED.length + ')')
    console.log('patch backup: ' + pluginPatchPath + ' (plain form: ' + PATCHED.length + ' rows removed on uninstall)')
  }
  console.log('')
  console.log('rollback    : node tools/workbench-install.mjs --uninstall --yes')
  console.log('next        : restart DSH yourself — this script never restarts it')
} else {
  /* uninstall: drop the patch rows and links, restore the previous artifacts */
  writeFileSync(pluginPatchPath, plainPatch)
  console.log('patch rows  : restored to the plain form')
  for (const entry of dirs) {
    if (existsSync(entry.link)) {
      try {
        unlinkSync(entry.link)
      } catch (error) {
        try {
          rmSync(entry.link, { recursive: false, force: true })
        } catch (second) {
          console.error('unlink failed: ' + entry.name + ' — ' + String(second.message ?? second))
        }
      }
      console.log('unlinked    : ' + entry.name)
    }
  }
  // Robust restore: prefer the pristine pre-swap implementation (lib.legacy, a clean copy
  // of the original artifact); fall back to the newest install backup. Backup directory
  // names from older runs may carry a trailing dot, which Windows normalizes away — access
  // them through the \\?\ prefix in that case.
  const legacy = join(repo, 'lib.legacy')
  const hasLegacy = existsSync(join(legacy, 'client.js'))
  const backups = existsSync(repo)
    ? readdirSync(repo, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('lib.bak-install-')).map((entry) => entry.name).sort()
    : []
  const restoreFrom = hasLegacy ? legacy : backups.length > 0 ? join(repo, backups[backups.length - 1]) : null
  if (restoreFrom !== null) {
    try {
      rmSync(join(repo, 'lib'), { recursive: true, force: true })
      const source = process.platform === 'win32' && !restoreFrom.startsWith('\\\\?\\') ? '\\\\?\\' + restoreFrom : restoreFrom
      cpSync(source, join(repo, 'lib'), { recursive: true })
      console.log('artifacts   : lib/ restored from ' + restoreFrom)
    } catch (error) {
      console.error('artifacts   : restore failed — ' + String(error.message ?? error))
      console.error('artifacts   : lib/ was removed; run node build.mjs and re-install, or restore lib.legacy manually')
    }
  } else {
    console.log('artifacts   : no pristine backup found; lib/ left as-is')
  }
  console.log('next        : restart DSH yourself — this script never restarts it')
}

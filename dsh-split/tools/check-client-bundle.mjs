#!/usr/bin/env node
/**
 * Client-half artifact guard.
 *
 * The DSH client-module loader serves a plugin's `client.js` VERBATIM to the browser
 * and expects the file to register ITSELF as a factory — that closure is the only
 * place `require` / `module` / `exports` exist. An artifact without that wrapper is
 * evaluated as an ES module, every `require` throws, the entry fails to activate and
 * — because web boot requires every entry — the whole window stops opening.
 * That is exactly what happened on 2026-10-15:
 * docs/evidence/incident-20261015-probe-web-boot.md
 *
 * This guard fails loudly on that class of defect (plus a few neighbours) before an
 * artifact can reach a user profile.
 *
 * Usage:
 *   node tools/check-client-bundle.mjs <path-to-client.js> [expected-module-id]
 *   node tools/check-client-bundle.mjs --self-test
 */
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const asBytes = (value) => (value < 1024 ? value + ' B' : (value / 1024).toFixed(1) + ' KiB')

export function checkBundle(file, expectedId) {
  const results = []
  const add = (name, ok, note) => results.push({ name, ok: Boolean(ok), note: note === undefined ? '' : String(note) })

  let code = ''
  try {
    code = readFileSync(file, 'utf8')
  } catch (error) {
    add('the artifact exists and is readable', false, String(error.message ?? error))
    return results
  }
  add('the artifact exists and is readable', true, asBytes(Buffer.byteLength(code)))

  // 1. The mandatory module-loader wrapper.
  const loadCall = code.includes('window.__ModuleLoader__.load(')
  add('registers itself via window.__ModuleLoader__.load({ id, factory })', loadCall,
    loadCall ? 'wrapper present' : 'MISSING — the browser would evaluate this as an ES module and require() would throw')

  const idMatch = /id:\s*['"]([^'"]+)['"]/.exec(code)
  add('the wrapper declares a module id', idMatch !== null, idMatch === null ? 'no id found' : idMatch[1])
  if (expectedId !== undefined && idMatch !== null) {
    add('the module id matches the package name', idMatch[1] === expectedId, idMatch[1] + ' vs ' + expectedId)
  }
  const factoryMatch = /factory:\s*(?:\(|function)/.test(code)
  add('the factory takes the loader-provided require', factoryMatch, factoryMatch ? '' : 'no factory(require) form found')
  // Evaluate the factory with a stub `require`: bundlers emit `apply` in several shapes
  // (`exports.apply = …`, `__export({ apply })`, …), so the decisive test is the value.
  let runtimeExports = null
  let runtimeError = null
  try {
    let record = null
    const scope = { window: { __ModuleLoader__: { load(value) { record = value } } } }
    // Permissive stub: bundles may `require` sibling packages at module scope, which must
    // not stop us from reading the exports (we only need `apply` / `inject`).
    const stub = new Proxy(function () {}, {
      get: (_target, property) => (property === 'then' ? undefined : stub),
      apply: () => stub,
      // Return a plain object so `class X extends React.Component` is constructible.
      construct: () => ({}),
    })
    const requireStub = () => stub
    new Function('window', 'require', 'module', 'exports', code)(scope.window, requireStub, { exports: {} }, {})
    if (record !== null && typeof record.factory === 'function') runtimeExports = record.factory(requireStub)
    else runtimeError = 'no __ModuleLoader__.load registration'
  } catch (error) {
    runtimeError = String(error.message ?? error)
  }
  add('the artifact exports apply() (Cordis client plugin)',
    runtimeExports !== null && typeof runtimeExports.apply === 'function',
    runtimeExports !== null && typeof runtimeExports.apply === 'function'
      ? 'apply() present' + (Array.isArray(runtimeExports.inject) ? ' · inject: ' + runtimeExports.inject.join(',') : ' · no inject export')
      : 'could not evaluate: ' + String(runtimeError))
  add('declares the services it reads (inject)',
    runtimeExports !== null && Array.isArray(runtimeExports.inject) && runtimeExports.inject.length > 0,
    runtimeExports !== null && Array.isArray(runtimeExports.inject) ? runtimeExports.inject.length + ' entries' : 'missing inject')

  // 2. The authoritative test for "no ES-module syntax" is compiling the file as a
  //    Script (below): top-level import/export or import.meta is a syntax error
  //    there. A regex over raw text would false-positive on the same words inside
  //    bundled strings — dockview ships such text, which is what this check used to
  //    flag. Keep only the cheap explicit import.meta probe as context.
  add('contains no import.meta', !code.includes('import.meta'), '')

  // 3. React must stay the host singleton.
  const ownReact = /react\.development\.js|__SECRET_INTERNALS_DO_NOT_USE|ReactDOM\s*=\s*\{/.test(code)
  add('does not bundle its own React runtime', !ownReact, ownReact ? 'React runtime found in the artifact' : '')
  const requiresReact = /require\(\s*['"]react['"]\s*\)/.test(code)
  add('takes React from the platform module table (external)', requiresReact,
    requiresReact ? 'require("react") present' : 'no require("react") — fine if this half needs no React')

  // 4. It must at least parse.
  try {
    new Script(code, { filename: file })
    add('parses as a script', true, '')
  } catch (error) {
    add('parses as a script', false, String(error.message ?? error))
  }

  return results
}

function printReport(file, results) {
  console.log('client-half guard: ' + file)
  for (const row of results) {
    console.log('  ' + (row.ok ? 'ok  ' : 'FAIL') + '  ' + row.name + (row.note === '' ? '' : ' — ' + row.note))
  }
  const failed = results.filter((row) => !row.ok)
  console.log('  → ' + (failed.length === 0 ? 'PASS' : failed.length + ' check(s) failed'))
  return failed.length
}

const [target, expectedId] = process.argv.slice(2)

if (target === '--self-test') {
  let failures = 0
  const wrapped = [
    "window.__ModuleLoader__.load({",
    "  id: 'demo',",
    '  factory: (require) => {',
    '    var module = { exports: {} }',
    '    var exports = module.exports',
    "    var React = require('react');",
    '    exports.apply = function apply() {};',
    '    exports.inject = ["slots"];',
    '    return module.exports',
    '  },',
    '})',
  ].join('\n')
  const unwrapped = "var React = require('react')\nexports.apply = function apply() {}\n"

  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-guard-'))
  const goodPath = path.join(dir, 'good.js')
  const badPath = path.join(dir, 'bad.js')
  fs.writeFileSync(goodPath, wrapped)
  fs.writeFileSync(badPath, unwrapped)

  const good = checkBundle(goodPath, 'demo')
  const bad = checkBundle(badPath, 'demo')
  const goodFailed = good.filter((row) => !row.ok).length
  const badFailed = bad.filter((row) => !row.ok).length
  console.log('self-test: a wrapped artifact')
  for (const row of good) console.log('  ' + (row.ok ? 'ok  ' : 'FAIL') + '  ' + row.name)
  console.log('self-test: an unwrapped artifact (the 2026-10-15 incident shape)')
  for (const row of bad) console.log('  ' + (row.ok ? 'ok  ' : 'FAIL') + '  ' + row.name)
  if (goodFailed !== 0) failures += 1
  if (badFailed === 0) failures += 1
  console.log('')
  console.log(failures === 0 ? 'self-test passed' : 'self-test failed')
  process.exit(failures === 0 ? 0 : 2)
}

if (target === undefined) {
  console.error('usage: node tools/check-client-bundle.mjs <client.js> [expected-module-id] | --self-test')
  process.exit(2)
}

process.exit(printReport(target, checkBundle(target, expectedId)) === 0 ? 0 : 2)

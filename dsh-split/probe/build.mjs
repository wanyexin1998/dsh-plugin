/**
 * Probe build: bundles `src/probe.js` into the client entry the DSH client-module
 * scanner loads (`lib/client.js`).
 *
 * Bundling is required because the probe exercises Dockview (W005), and the host
 * does not ship that library — the plugin's own copy must be inlined. React is
 * NOT bundled: the client runtime provides it as a platform module
 * (`require('react')`), and shipping a second React is a W008 acceptance failure.
 *
 * The wrapper emitted below is MANDATORY: the loader serves `client.js` verbatim and
 * expects the file to register itself as a factory, which is where `require`,
 * `module` and `exports` come from. Without it the browser evaluates the file as an
 * ES module and every `require` throws "require is not defined"; because web boot
 * requires every entry to activate, that keeps the whole window from opening.
 * (Incident: docs/evidence/incident-20261015-probe-web-boot.md.)
 *
 * Usage: node build.mjs
 */
import { build } from 'esbuild'

const MODULE_ID = 'dsh-split-probe'

const result = await build({
  entryPoints: ['src/probe.js'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome126'],
  external: ['react'],
  loader: { '.css': 'text' },
  legalComments: 'inline', /* keep the bundled MIT notices (dockview) */
  logLevel: 'info',
  metafile: true,
  banner: {
    js: [
      '/**',
      ' * GENERATED FILE, do not edit. Source: probe/src/probe.js · Build: probe/build.mjs',
      ' * Bundled third-party code keeps its own license headers (dockview, MIT).',
      ' */',
      'window.__ModuleLoader__.load({',
      `  id: '${MODULE_ID}',`,
      '  factory: (require) => {',
      '    var module = { exports: {} }',
      '    var exports = module.exports',
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports', '  },', '})', ''].join('\n'),
  },
})

const outputs = Object.entries(result.metafile.outputs)
for (const [file, info] of outputs) {
  console.log(`built ${file} — ${info.bytes} bytes, ${Object.keys(info.inputs).length} inputs`)
}

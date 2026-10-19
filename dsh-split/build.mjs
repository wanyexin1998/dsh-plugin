/**
 * Build the plugin: `src/**` → `dist/**`.
 *
 * Outputs
 *  - `dist/client.js` — the browser half, wrapped in the module-loader factory the client
 *    runtime expects (`window.__ModuleLoader__.load({ id, factory })`). Without that wrapper
 *    the browser evaluates the file as an ES module, `require` throws, the entry fails to
 *    activate and web boot stops opening the window — see
 *    docs/evidence/incident-20261015-probe-web-boot.md.
 *  - `dist/index.js` — the host half (ESM; the package is `type: module`).
 *  - `dist/layout.mjs` — the pure layout module, built for `tests/layout.test.mjs`.
 *
 * React, ReactDOM and Dockview: React/ReactDOM stay EXTERNAL (platform modules, never a
 * second copy); `dockview-core` is bundled because the host does not ship it.
 *
 * The output stays in `dist/` until the swap to `lib/` is deliberate: while `dist/` is the
 * target, the installed plugin keeps running its previous artifact.
 *
 * Usage: node build.mjs
 */
import { build } from 'esbuild'
import { readDockviewCss } from './tools/dockview-css.mjs'

const shared = {
  bundle: true,
  platform: 'browser',
  target: ['chrome126'],
  legalComments: 'inline', /* keep bundled third-party notices (dockview, MIT) */
  logLevel: 'info',
  metafile: true,
  jsx: 'transform',
}

const results = []

results.push(
  await build({
    ...shared,
    entryPoints: ['src/client.ts'],
    outfile: 'dist/client.js',
    format: 'cjs',
    define: { __DSH_SPLIT_DOCKVIEW_CSS__: JSON.stringify(readDockviewCss()) },
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    banner: {
      js: [
        '/**',
        ' * GENERATED FILE — do not edit. Source: src/ · Build: build.mjs',
        ' * Bundled third-party code keeps its own license headers (dockview-core, MIT).',
        ' */',
        'window.__ModuleLoader__.load({',
        "  id: 'dsh-split',",
        '  factory: (require) => {',
        '    var module = { exports: {} }',
        '    var exports = module.exports',
      ].join('\n'),
    },
    footer: { js: ['    return module.exports', '  },', '})', ''].join('\n') },
  }),
)

results.push(
  await build({
    ...shared,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    format: 'esm',
  }),
)

results.push(
  await build({
    ...shared,
    entryPoints: ['src/layout.ts'],
    outfile: 'dist/layout.mjs',
    format: 'esm',
  }),
)

for (const result of results) {
  for (const [file, info] of Object.entries(result.metafile.outputs)) {
    console.log(`built ${file} — ${info.bytes} bytes, ${Object.keys(info.inputs).length} inputs`)
  }
}

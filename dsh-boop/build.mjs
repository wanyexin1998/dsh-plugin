/**
 * Build the BOOP plugin: `src/**` -> `lib/**`.
 *
 * Outputs
 *  - `lib/client.js` — browser half, wrapped in the module-loader factory the
 *    client runtime expects (`window.__ModuleLoader__.load({ id, factory })`).
 *    React stays EXTERNAL: it is a platform module seeded by the shell's
 *    PLATFORM_MODULES table (React 18.3.1); bundling a second copy breaks the
 *    single-React rule (TB02).
 *  - `lib/index.js` — host half (ESM cordis function-plugin).
 *  - `lib/tools.js`, `lib/api.js` — host subpath entries.
 *
 * Usage: node build.mjs
 */
// The native esbuild binary is blocked from reading files by the host security
// policy on this machine (winapi error #5), so the builder uses esbuild-wasm —
// same API, in-process, no child process. Keep `esbuild` in devDependencies for
// type/source parity; if a machine allows the native binary, swapping the import
// below is the only change required.
import * as esbuild from 'esbuild-wasm'
const { build } = esbuild

const shared = {
  bundle: true,
  platform: 'browser',
  target: ['chrome126'],
  legalComments: 'inline',
  logLevel: 'info',
  metafile: true,
  jsx: 'transform',
}

const results = []

results.push(
  await build({
    ...shared,
    entryPoints: ['src/client/index.tsx'],
    outfile: 'lib/client.js',
    format: 'cjs',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    banner: {
      js: [
        '/**',
        ' * GENERATED FILE — do not edit. Source: src/client · Build: build.mjs',
        ' */',
        'window.__ModuleLoader__.load({',
        "  id: 'dsh-boop',",
        '  factory: (require) => {',
        '    var module = { exports: {} }',
        '    var exports = module.exports',
      ].join('\n'),
    },
    footer: { js: ['    return module.exports', '  },', '})', ''].join('\n') },
  }),
)

// Node-testable bundles (CommonJS, react external). Appended per E04-01 batch 2:
// the main-Session navigation policy and the interaction components are rendered
// in jsdom from these bundles, so esbuild keeps processing/aliasing out of the
// test path. `react` stays external and resolves from this package's node_modules.
const testBundles = [
  ['src/client/board.tsx', 'lib/companion3d.test.bundle.cjs'],
  ['src/client/main-session.ts', 'lib/main-session.test.bundle.cjs'],
  ['src/client/init.tsx', 'lib/init.test.bundle.cjs'],
  ['src/client/source.tsx', 'lib/source.test.bundle.cjs'],
  ['src/client/header.tsx', 'lib/header.test.bundle.cjs'],
  ['src/client/settings.tsx', 'lib/settings.test.bundle.cjs'],
  // E04-02 client half: the taskboard panel + its pure projection/command logic.
  ['src/client/taskboard/index.tsx', 'lib/taskboard.test.bundle.cjs'],
  // E04-03 client half: approval / stop / recovery control surfaces.
  ['src/client/control.tsx', 'lib/control.test.bundle.cjs'],
]
for (const [entry, outfile] of testBundles) {
  results.push(
    await build({
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      logLevel: 'info',
      metafile: true,
      entryPoints: [entry],
      outfile,
      external: ['react', 'react-dom', 'jsdom'],
    }),
  )
}

// `workspace-api.ts` is its own host row (`boop-workspace` in cordis.patch.yml)
// so the workspace/Session management plane can be mounted, disabled or tested
// independently of the main BOOP runtime row and the PoC API row. `tasks-api.ts`
// is the same for the E04-02 read-only Taskboard projection row (`boop-tasks`),
// `control-api.ts` for the E04-03 human control row (`boop-control`),
// `scheduler-api.ts` for the E05-01 scheduler/patrol row (`boop-scheduler`),
// `verify/verify-api.ts` for the E05-02 evidence-verification row (`boop-verify`),
// and `gate/pre-step-api.ts` for the G04 runtime `agent/pre-step` gate row
// (`boop-gate`).
for (const entry of [
  'src/host/index.ts',
  'src/host/tools.ts',
  'src/host/api.ts',
  'src/host/assets.ts',
  'src/host/workspace-api.ts',
  'src/host/tasks-api.ts',
  'src/host/control-api.ts',
  'src/host/scheduler-api.ts',
  'src/host/verify/verify-api.ts',
  'src/host/gate/pre-step-api.ts',
]) {
  results.push(
    await build({
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      legalComments: 'inline',
      logLevel: 'info',
      metafile: true,
      entryPoints: [entry],
      outfile: `lib/${entry.split('/').pop().replace(/\.ts$/, '.js')}`,
      // Host packages resolve at runtime through the DSH runtime resolution;
      // bundling a second copy would drift from the host's own instance.
      external: ['@deepseek-ai/*'],
    }),
  )
}

for (const result of results) {
  for (const [file, info] of Object.entries(result.metafile.outputs)) {
    console.log(`built ${file} — ${info.bytes} bytes, ${Object.keys(info.inputs).length} inputs`)
  }
}

// Bundles the three published entry points of the dsh-data-ide plugin.
//
//   lib/index.js       node half — host-side lifecycle (empty in M0)
//   lib/client.js      browser half — right-sidebar tab registration
//   lib/mcp/server.js  MCP server (stdio) exposed to the agent
//
// The browser half is NOT an ES module: dsh loads it as a classic script that
// must register itself through `window.__ModuleLoader__`, and the factory
// receives the shell's module-table `require` (React and friends come from
// there). Stylesheets are inlined as text and injected inside the factory,
// because the loader never fetches a sibling `client.css`
// (`packages/client/modules/src/client/manifest.ts` L10-16).

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

/** Package name; the loader keys its factory registration by exactly this id. */
const PLUGIN_ID = 'dsh-data-ide'

/** Bare specifiers resolved by the shell module table, never bundled. */
const SHELL_MODULES = ['react', 'react-dom', 'react-dom/client']

/** Wrap CommonJS output in the host's bundle registration contract. */
function wrapForHostLoader(code) {
  return `window.__ModuleLoader__.load({
  id: '${PLUGIN_ID}',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
;(function (require, module, exports) {
${code}
})(require, module, module.exports)
    return module.exports
  },
})
`
}

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  target: 'es2022',
  logLevel: 'info',
  sourcemap: false,
}

const nodeTarget = {
  ...shared,
  format: 'esm',
  platform: 'node',
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'lib/index.js'),
  // The host half executes SQL for the panel, so it pulls in the same driver
  // the MCP server uses. mysql2 is a real package dependency (package.json) and
  // ships with its own dynamic requires; bundling it breaks or bloats.
  external: ['mysql2', 'mysql2/promise'],
}

const mcpTarget = {
  ...nodeTarget,
  entryPoints: [resolve(root, 'mcp/entry.ts')],
  outfile: resolve(root, 'lib/mcp/server.js'),
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', 'mysql2'],
}

const clientTarget = {
  ...shared,
  format: 'cjs',
  platform: 'browser',
  // Classic JSX: the shell module table seeds `react`, not `react/jsx-runtime`,
  // and an unknown specifier is a loud resolution failure at materialization.
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  external: SHELL_MODULES,
  loader: { '.css': 'text' },
  entryPoints: [resolve(root, 'src/client/index.ts')],
  outfile: resolve(root, 'lib/client.js'),
}

await build(nodeTarget)
await build(mcpTarget)

if (watch) {
  const { context } = await import('esbuild')
  const ctx = await context(clientTarget)
  await ctx.watch()
} else {
  const bundled = await build({ ...clientTarget, write: false })
  writeFileSync(clientTarget.outfile, wrapForHostLoader(bundled.outputFiles[0].text), 'utf8')
}

// Declaration output mirrors the export map (`lib/types/**`), which the
// profile's TypeScript consumers resolve through `exports[].types`.
const tsc = spawnSync(process.execPath, [resolve(root, '../../../node_modules/typescript/bin/tsc'), '-p', root], {
  stdio: 'inherit',
})
if (tsc.status !== 0) process.exit(tsc.status ?? 1)

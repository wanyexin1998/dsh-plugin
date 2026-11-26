import * as esbuild from 'esbuild-wasm'

const results = []
const shared = {
  bundle: true,
  target: ['chrome126'],
  legalComments: 'inline',
  logLevel: 'info',
  jsx: 'transform',
  loader: { '.css': 'text' },
}

results.push(await esbuild.build({
  ...shared,
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  format: 'cjs',
  minify: true,
  external: ['react', 'react-dom'],
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      "  id: 'dsh-visualize-inline',",
      '  factory: (require) => {',
      '    var module = { exports: {} }',
      '    var exports = module.exports',
    ].join('\n'),
  },
  footer: { js: ['    return module.exports', '  },', '})', ''].join('\n') },
}))

results.push(await esbuild.build({
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  logLevel: 'info',
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  external: ['@deepseek-ai/*'],
}))

for (const [entryPoints, outfile, format] of [
  [['src/protocol.ts'], 'lib/protocol.js', 'esm'],
  [['src/guidance.ts'], 'lib/guidance.js', 'esm'],
  [['src/client/scale.ts'], 'lib/scale.js', 'esm'],
  [['src/client/flow-layout.ts'], 'lib/flow-layout.js', 'esm'],
  [['src/protocol-v2.ts'], 'lib/protocol-v2.js', 'esm'],
  [['src/client/expressions.ts'], 'lib/expressions.js', 'esm'],
  [['src/client/VisualizeFence.tsx'], 'lib/client.test.cjs', 'cjs'],
  [['src/client/index.ts'], 'lib/client-entry.test.cjs', 'cjs'],
]) {
  results.push(await esbuild.build({
    ...shared,
    platform: 'node',
    target: 'node22',
    entryPoints,
    outfile,
    format,
    external: ['react', 'react-dom'],
  }))
}

for (const result of results) {
  for (const [file, info] of Object.entries(result.metafile?.outputs ?? {})) {
    console.log(`built ${file} — ${info.bytes} bytes`)
  }
}

import { readdir } from 'node:fs/promises'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'lib')
if (resolve(output) !== join(root, 'lib')) throw new Error('unsafe build output')
await readdir(root).catch(() => {
  throw new Error('connector package root missing')
})
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
}
await build({ ...common, entryPoints: [join(root, 'src/index.ts')], outfile: join(output, 'connector.mjs') })
await build({
  ...common,
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(output, 'main.mjs'),
  banner: { js: '#!/usr/bin/env node' },
})
// The bundled executor imports the pinned official catalog relative to its own URL.
await mkdir(output, { recursive: true })
await copyFile(join(root, '../enhancements/src/catalog/catalog.json'), join(output, 'catalog.json'))
console.log('Built standalone Connector bundle (lib/connector.mjs, lib/main.mjs).')

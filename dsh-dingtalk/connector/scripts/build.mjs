import { readFile, readdir } from 'node:fs/promises'
import { copyFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
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
// src/main.ts already starts with a shebang; esbuild preserves exactly one. Do not add a banner
// here or the output would contain a duplicate shebang on line 2 and fail to execute.
await build({
  ...common,
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(output, 'main.mjs'),
})
// The bundled executor imports the pinned official catalog relative to its own URL.
await mkdir(output, { recursive: true })
await copyFile(join(root, '../enhancements/src/catalog/catalog.json'), join(output, 'catalog.json'))
// Fail the build (including the image builder stage) if the CLI entry cannot start.
const entry = await readFile(join(output, 'main.mjs'), 'utf8')
const firstLines = entry.split('\n', 3)
if (!firstLines[0].startsWith('#!') || firstLines.slice(1).some((line) => line.startsWith('#!'))) {
  throw new Error('built CLI entry must contain exactly one shebang on the first line')
}
const version = spawnSync(process.execPath, [join(output, 'main.mjs'), 'version'], { encoding: 'utf8' })
if (version.status !== 0 || !version.stdout.includes('dsh-dingtalk-connector')) {
  throw new Error(`built CLI entry failed to execute: ${version.status} ${version.stderr}`)
}
console.log('Built standalone Connector bundle (lib/connector.mjs, lib/main.mjs).')

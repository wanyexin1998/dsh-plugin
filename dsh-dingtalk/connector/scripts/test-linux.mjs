#!/usr/bin/env node
// Build and run the Linux-only Connector test image with the pinned DWS artifact.
// Usage: node scripts/test-linux.mjs [--no-cache] [--keep]
import { spawnSync } from 'node:child_process'
import { copyFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = resolve(root, '..')
const lock = JSON.parse(await readFile(join(packageRoot, 'enhancements', 'dws.lock.json'), 'utf8'))
const asset = lock.dws.assets.find((item) => item.platform === 'linux-amd64')
if (!asset) throw new Error('linux-amd64 asset missing from dws.lock.json')
const archive = join(packageRoot, '.cache', 'dws-artifact', asset.filename ?? 'dws-linux-amd64.tar.gz')
let bytes
try {
  bytes = await readFile(archive)
} catch {
  console.log(`downloading ${asset.url}`)
  const response = await fetch(asset.url)
  if (!response.ok) throw new Error(`download failed: ${response.status}`)
  bytes = Buffer.from(await response.arrayBuffer())
  await import('node:fs/promises').then((fs) => fs.mkdir(dirname(archive), { recursive: true }))
  await writeFile(archive, bytes)
}
const sha = createHash('sha256').update(bytes).digest('hex')
if (bytes.length !== asset.size || sha !== asset.sha256) throw new Error(`archive integrity mismatch: ${sha}`)
const binarySha = lock.dws.binaryChecksums['linux-x64']
console.log(`archive verified ${sha} (${bytes.length} bytes)`)
const context = await mkdtemp(join(tmpdir(), 'dsh-connector-linux-'))
try {
  await writeFile(join(context, 'archive.tar.gz'), bytes)
  await cp(join(packageRoot, 'enhancements', 'lib'), join(context, 'enhancements', 'lib'), { recursive: true })
  await cp(join(packageRoot, 'enhancements', 'dws.lock.json'), join(context, 'enhancements', 'dws.lock.json'))
  await cp(join(packageRoot, 'enhancements', 'package.json'), join(context, 'enhancements', 'package.json'))
  await cp(join(root, 'lib'), join(context, 'connector', 'lib'), { recursive: true })
  await cp(join(root, 'tests'), join(context, 'connector', 'tests'), { recursive: true })
  await cp(join(root, 'version.json'), join(context, 'connector', 'version.json'))
  await cp(join(root, 'package.json'), join(context, 'connector', 'package.json'))
  await copyFile(join(root, 'docker', 'Dockerfile.test'), join(context, 'Dockerfile'))
  const tag = `dsh-dingtalk-connector-test:${sha.slice(0, 12)}`
  const buildArgs = [
    'build',
    '-t',
    tag,
    '--build-arg',
    `DWS_ARCHIVE_SHA256=${sha}`,
    '--build-arg',
    `DWS_BINARY_SHA256=${binarySha}`,
    ...(process.argv.includes('--no-cache') ? ['--no-cache'] : []),
    '.',
  ]
  console.log(`docker ${buildArgs.join(' ')} (cwd ${context})`)
  const built = spawnSync('docker', buildArgs, { stdio: 'inherit', shell: false, cwd: context })
  if (built.status !== 0) throw new Error(`docker build failed: ${built.status}`)
  const run = spawnSync('docker', ['run', '--rm', tag], { stdio: 'inherit', shell: false })
  if (run.status !== 0) throw new Error(`linux tests failed: ${run.status}`)
  console.log('linux Connector tests passed')
} finally {
  if (!process.argv.includes('--keep')) await rm(context, { recursive: true, force: true })
  else console.log(`kept build context ${context}`)
}

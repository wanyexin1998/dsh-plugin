#!/usr/bin/env node
// Cross-check every pinned version/digest against the plugin lock and deploy templates.
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = resolve(root, '..')
const read = async (...parts) => readFile(join(root, ...parts), 'utf8')
const manifest = JSON.parse(await read('version.json'))
const lock = JSON.parse(await readFile(join(packageRoot, 'enhancements', 'dws.lock.json'), 'utf8'))
const plugin = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
const dockerfile = await read('docker', 'Dockerfile')
const failures = []
const check = (name, actual, expected) => {
  if (actual !== expected) failures.push({ name, expected, actual })
}
const dws = manifest.dws
check('dws.version', dws.version, lock.dws.version)
check('dws.commit', dws.commit, lock.dws.commit)
check(
  'dws.linuxAmd64.archiveSha256',
  dws.linuxAmd64.archiveSha256,
  lock.dws.assets.find((asset) => asset.platform === 'linux-amd64')?.sha256,
)
check(
  'dws.linuxAmd64.archiveSize',
  dws.linuxAmd64.archiveSize,
  lock.dws.assets.find((asset) => asset.platform === 'linux-amd64')?.size,
)
check('dws.linuxAmd64.binarySha256', dws.linuxAmd64.binarySha256, lock.dws.binaryChecksums['linux-x64'])
check('plugin.version', manifest.plugin.version, plugin.version)
const dockerArg = (name) => new RegExp(`ARG ${name}=([^\\s]+)`).exec(dockerfile)?.[1]
check('Dockerfile.DWS_ARCHIVE_SHA256', dockerArg('DWS_ARCHIVE_SHA256'), dws.linuxAmd64.archiveSha256)
check('Dockerfile.DWS_BINARY_SHA256', dockerArg('DWS_BINARY_SHA256'), dws.linuxAmd64.binarySha256)
check('Dockerfile.DWS_VERSION', dockerArg('DWS_VERSION'), dws.version)
check('Dockerfile.DWS_COMMIT', dockerArg('DWS_COMMIT'), dws.commit)
const compose = await read('deploy', 'compose.yaml')
if (!compose.includes('connector-state:/var/lib/dsh-dingtalk-connector'))
  failures.push({ name: 'compose.private-volume', expected: 'connector-state mounted', actual: 'missing' })
if (/image:\s*[^\s]*:latest/.test(compose))
  failures.push({ name: 'compose.latest-tag', expected: 'no :latest image tag', actual: 'found' })
if (!/healthcheck:/.test(compose))
  failures.push({ name: 'compose.healthcheck', expected: 'healthcheck present', actual: 'missing' })
const report = {
  ok: failures.length === 0,
  connectorVersion: manifest.connectorVersion,
  protocolVersion: manifest.protocolVersion,
  dws: dws.version,
  checks: failures.length ? failures : 'all pins match',
}
console.log(JSON.stringify(report, null, 2))
if (failures.length) process.exitCode = 1

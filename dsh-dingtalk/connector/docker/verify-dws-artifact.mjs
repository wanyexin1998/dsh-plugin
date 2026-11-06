#!/usr/bin/env node
// Self-contained pinned-DWS installer for the container build stage: no apt, no curl, no runtime
// network. Verifies archive SHA256, extracts the single `dws` member, verifies binary SHA256,
// installs it 0555 and executes `--version` against the pinned version/commit.
// Usage: node verify-dws-artifact.mjs --url <archive> --archive-sha256 <sha> --binary-sha256 <sha> --version <v> --commit <sha> --output <path>
import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(`--${name}`)
  if (index < 0 || !args[index + 1]) throw new Error(`missing --${name}`)
  return args[index + 1]
}
const url = option('url')
const archiveSha = option('archive-sha256')
const binarySha = option('binary-sha256')
const version = option('version')
const commit = option('commit')
const output = option('output')
// The pinned SHA256 arguments are the trust anchor; mirrors are acceptable when the digest matches.
if (!/^https:\/\//.test(url)) throw new Error('archive URL must be https')
if (!/^[a-f0-9]{64}$/.test(archiveSha) || !/^[a-f0-9]{64}$/.test(binarySha))
  throw new Error('invalid checksum argument')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const MAX = 134217728

const response = await fetch(url, { redirect: 'follow' })
if (!response.ok || !response.body) throw new Error(`download failed: ${response.status}`)
const reader = response.body.getReader()
const chunks = []
let size = 0
for (;;) {
  const next = await reader.read()
  if (next.done) break
  size += next.value.length
  if (size > MAX) throw new Error('archive too large')
  chunks.push(Buffer.from(next.value))
}
const archive = Buffer.concat(chunks)
if (sha(archive) !== archiveSha) throw new Error(`archive sha256 mismatch: ${sha(archive)}`)

const octal = (header, offset, length) => {
  const text = header
    .subarray(offset, offset + length)
    .toString('latin1')
    .replace(/\0[\s\S]*$/, '')
    .trim()
  if (text === '') return 0
  if (!/^[0-7]{1,11}$/.test(text)) throw new Error('invalid tar header')
  return Number.parseInt(text, 8)
}
const text = (bytes) => bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString('utf8')
const eligible = (name) => {
  const normalized = name.trim().replace(/^\.\//, '')
  if (normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) return false
  return normalized === 'dws' || /^[A-Za-z0-9._-]+\/dws$/.test(normalized)
}
const tar = gunzipSync(archive, { maxOutputLength: MAX })
const found = []
let offset = 0
let entries = 0
let pendingName
while (offset + 512 <= tar.length) {
  const header = tar.subarray(offset, offset + 512)
  if (header.every((byte) => byte === 0)) break
  if (++entries > 1000) throw new Error('too many archive entries')
  const expected = octal(header, 148, 8)
  let sum = 0
  for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index]
  if (sum !== expected) throw new Error('tar checksum mismatch')
  const type = String.fromCharCode(header[156] || 0x30)
  const entrySize = octal(header, 124, 12)
  if (entrySize > MAX || offset + 512 + entrySize > tar.length) throw new Error('invalid tar entry size')
  const data = tar.subarray(offset + 512, offset + 512 + entrySize)
  if (type === 'x' || type === 'L') {
    const content = data.toString('utf8')
    const match = /^\d+ path=(.*)$/m.exec(content)
    pendingName = type === 'x' ? match?.[1] : text(data)
  } else if (type === '0' || type === '\0') {
    const prefix = text(header.subarray(345, 345 + 155))
    const declared =
      pendingName ?? (prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100)))
    pendingName = undefined
    if (eligible(declared)) found.push(Buffer.from(data))
  } else {
    if (type === '1' || type === '2') {
      const prefix = text(header.subarray(345, 345 + 155))
      if (eligible(prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100))))
        throw new Error('archive links are not allowed')
    }
    pendingName = undefined
  }
  offset += 512 + Math.ceil(entrySize / 512) * 512
}
if (found.length !== 1) throw new Error(`expected exactly one dws binary, found ${found.length}`)
const binary = found[0]
if (sha(binary) !== binarySha) throw new Error(`binary sha256 mismatch: ${sha(binary)}`)
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, binary, { mode: 0o555 })
const versioned = spawnSync(output, ['--version'], {
  encoding: 'utf8',
  timeout: 60000,
  env: { PATH: process.env.PATH, DWS_NO_UPDATE_CHECK: '1' },
})
const line = (versioned.stdout || '').split('\n')[0].trim()
if (versioned.status !== 0 || !line.startsWith(`dws version v${version} (${commit},`))
  throw new Error(`unexpected pinned version output: ${line || versioned.stderr}`)
console.log(`verified dws ${version} archive=${archiveSha} binary=${binarySha}`)

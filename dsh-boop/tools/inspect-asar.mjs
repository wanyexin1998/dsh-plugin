/**
 * Read-only asar utilities against the installed DSH app.
 *
 * Usage:
 *   node tools/inspect-asar.mjs --size <entry-path>
 *   node tools/inspect-asar.mjs --extract <entry-path> <dest-dir>
 *   node tools/inspect-asar.mjs --list <dir-entry-path>
 *
 * Entry paths are relative inside the asar, e.g. `dsh/node_modules/@deepseek-ai/dsh`.
 * DSH_ASAR env var overrides the default installation path.
 */
import fs from 'node:fs'
import path from 'node:path'

const ASAR = process.env.DSH_ASAR
if (!ASAR) {
  console.error('DSH_ASAR is required; this tool has no personal default path')
  process.exit(1)
}
const fd = fs.openSync(ASAR, 'r')
try {
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const jsonSize = head.readUInt32LE(12)
  const json = Buffer.alloc(jsonSize)
  fs.readSync(fd, json, 0, jsonSize, 16)
  const root = JSON.parse(json.toString('utf8'))
  const baseOffset = 8 + head.readUInt32LE(4)

  function resolve(entryPath) {
    let node = root
    for (const segment of entryPath.split('/').filter(Boolean)) node = node?.files?.[segment]
    return node
  }

  function extract(node, dest) {
    fs.mkdirSync(dest, { recursive: true })
    for (const [name, child] of Object.entries(node.files)) {
      const target = path.join(dest, name)
      if (child.files) {
        extract(child, target)
      } else if (child.offset !== undefined) {
        const buf = Buffer.alloc(child.size)
        fs.readSync(fd, buf, 0, child.size, baseOffset + Number(child.offset))
        fs.writeFileSync(target, buf)
      }
    }
  }

  function total(node) {
    let files = 0
    let bytes = 0
    const stack = [node]
    while (stack.length) {
      const n = stack.pop()
      for (const child of Object.values(n.files ?? {})) {
        if (child.files) stack.push(child)
        else {
          files++
          bytes += child.size
        }
      }
    }
    return { files, bytes }
  }

  const [mode, entryPath, dest] = process.argv.slice(2)
  const node = resolve(entryPath)
  if (!node) {
    console.error(`entry not found: ${entryPath}`)
    process.exit(1)
  }
  if (mode === '--size') {
    const { files, bytes } = total(node)
    console.log(`${entryPath}: ${files} files, ${(bytes / 1048576).toFixed(2)} MiB`)
  } else if (mode === '--extract') {
    const target = path.resolve(dest)
    if (node.files) {
      extract(node, target)
    } else if (node.offset !== undefined) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const buf = Buffer.alloc(node.size)
      fs.readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset))
      fs.writeFileSync(target, buf)
    } else {
      console.error(`entry is not extractable: ${entryPath}`)
      process.exit(1)
    }
    console.log(`extracted ${entryPath} -> ${target}`)
  } else if (mode === '--list') {
    for (const name of Object.keys(node.files ?? {})) console.log(name)
  } else {
    console.error('usage: --size <entry> | --extract <entry> <dest> | --list <entry>')
    process.exit(2)
  }
} finally {
  fs.closeSync(fd)
}

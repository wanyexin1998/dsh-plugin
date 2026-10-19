import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, resolve, sep } from 'node:path'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }
createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const file = resolve(root, '.' + pathname)
    if (!file.startsWith(root + sep) || !statSync(file).isFile()) throw new Error('not found')
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(readFileSync(file))
  } catch { res.writeHead(404); res.end('Not found') }
}).listen(4417, '127.0.0.1', () => console.log('V5 reference/test server: http://127.0.0.1:4417'))

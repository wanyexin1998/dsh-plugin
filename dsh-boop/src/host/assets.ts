/**
 * Read-only asset routes for the BOOP 3D character (E04-01).
 *
 * The player fetches the actual `.glb` from the host (the asset package says:
 * "生产插件请使用实际 .glb 静态文件，不重复内嵌整个 HTML"). Routes are EXACT
 * paths under `/api/boop/` and every served file is whitelisted by name — no
 * directory traversal, no arbitrary path join, no user-controlled filename.
 *
 * Files are read once and cached in memory: the model is 1.3 MB and immutable
 * for a given plugin build.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'boop-assets'

export const inject = ['connection']

/** Exact URL → file map. Nothing outside this table can be served. */
const FILES: Record<string, { file: string; type: string }> = {
  '/api/boop/model.glb': { file: 'boop.glb', type: 'model/gltf-binary' },
  '/api/boop/player.js': { file: 'boop-assistant.js', type: 'text/javascript; charset=utf-8' },
  '/api/boop/state-idle.png': { file: 'states/boop-idle-256.png', type: 'image/png' },
  '/api/boop/state-listen.png': { file: 'states/boop-listen-256.png', type: 'image/png' },
  '/api/boop/state-think.png': { file: 'states/boop-think-256.png', type: 'image/png' },
  '/api/boop/state-success.png': { file: 'states/boop-success-256.png', type: 'image/png' },
  '/api/boop/state-error.png': { file: 'states/boop-error-256.png', type: 'image/png' },
}

function assetRoot(): string {
  // This module lives at <pkg>/lib/assets.js after the build; the package root
  // is one level up, and the assets live in <pkg>/assets/3d.
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(here, '..', 'assets', '3d')
}

interface Cached {
  bytes: Buffer
  etag: string
  type: string
}

export class BoopAssetServer {
  private readonly root: string
  private readonly cache = new Map<string, Cached>()

  constructor(root = assetRoot()) {
    this.root = root
  }

  /** Names that may be served — used by the activation check and by tests. */
  static routes(): string[] {
    return Object.keys(FILES)
  }

  load(route: string): Cached | null {
    const entry = FILES[route]
    if (!entry) return null
    const cached = this.cache.get(route)
    if (cached) return cached
    const file = path.join(this.root, entry.file)
    // Defence in depth: the joined path must stay inside the asset root.
    const resolved = path.resolve(file)
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) return null
    if (!fs.existsSync(resolved)) return null
    const bytes = fs.readFileSync(resolved)
    const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`
    const value: Cached = { bytes, etag, type: entry.type }
    this.cache.set(route, value)
    return value
  }

  /** HEAD/GET handler with ETag revalidation and immutable caching. */
  handler(route: string) {
    return async (request: Request): Promise<Response> => {
      const asset = this.load(route)
      if (!asset) return new Response('not found', { status: 404 })
      if (request.headers.get('if-none-match') === asset.etag) {
        return new Response(null, { status: 304, headers: { etag: asset.etag } })
      }
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(asset.bytes), {
        status: 200,
        headers: {
          'content-type': asset.type,
          'content-length': String(asset.bytes.byteLength),
          'cache-control': 'private, max-age=31536000, immutable',
          etag: asset.etag,
        },
      })
    }
  }
}

export function apply(ctx: any): void {
  try {
    const server = new BoopAssetServer()
    const connection = ctx.reflect?.get?.('connection', false)
    const register = connection?.fetch?.register
    if (typeof register !== 'function') {
      ctx.logger?.warn?.('[boop] asset routes unavailable: connection.fetch.register is not present')
      return
    }
    for (const route of BoopAssetServer.routes()) {
      ctx.effect(
        () =>
          connection.fetch.register({
            path: route,
            methods: ['GET', 'HEAD'],
            requestBody: 'buffered',
            fetch: server.handler(route),
          }),
        `boop: asset route ${route}`,
      )
    }
    ctx.logger?.info?.(`[boop] asset routes armed: ${BoopAssetServer.routes().length} exact paths`)
  } catch (error) {
    ctx.logger?.warn?.('[boop] asset routes failed to arm; the 3D character will fall back to PNG', error)
  }
}
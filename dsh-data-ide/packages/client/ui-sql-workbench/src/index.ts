/**
 * Node half — host-side lifecycle.
 *
 * Owns the profile seams (storage domain, credential store), publishes the
 * resolved connection specs the MCP server reads, and mounts the panel's HTTP
 * routes on the composition's `webServer`. The host remains the single writer
 * for configuration and secrets (docs/02 §3); unloading releases the service,
 * the runtime spec file, the storage unit and the routes.
 */

import { startHostServices } from './host/binding.ts'
import type { ConnectionService, NodeHostContext, WebServerService } from './host/contract.ts'
import { registerPanelRoutes } from './host/web-routes.ts'

/** Host services this half needs. */
export const inject = ['storageDomain', 'credentials']

/** Everything the panel needs from the node half. */
export const injectOptional = ['webServer', 'connection']

/** Read a service opportunistically; absent is a normal composition. */
function lookup<T>(ctx: NodeHostContext, name: string): T | undefined {
  const service = ctx.get?.(name)
  return service === undefined ? undefined : (service as T)
}

/**
 * Open host services and mount the panel routes for the plugin's lifetime.
 *
 * Cordis validates what an effect hands back: a function (disposer) or nothing.
 * An async effect may resolve to that disposer — but it must not resolve to an
 * object, or the fiber dies with `TypeError: Invalid effect` and the whole node
 * entry goes dark (which is exactly how the panel once lost its backend).
 *
 * @param ctx - Root node context; the effect owns setup and teardown.
 */
export function apply(ctx: NodeHostContext): void {
  ctx.effect(async () => {
    const started = await startHostServices(ctx)

    const webServer = lookup<WebServerService>(ctx, 'webServer') ?? ctx.webServer
    let unmount: (() => void) | undefined
    if (webServer === undefined) {
      // Fail closed and loudly: without routes the panel can show connections but
      // can neither read nor execute, and that must not be silent.
      console.error('dsh-data-ide: 宿主未提供 webServer，面板无法与后端通信（该 composition 不支持外部路由）')
    } else {
      const connection = lookup<ConnectionService>(ctx, 'connection')
      unmount = registerPanelRoutes(
        webServer,
        started.api,
        connection === undefined ? undefined : req => connection.requestRejection(req),
      )
    }

    return async () => {
      unmount?.()
      await started.dispose()
    }
  }, 'dsh-data-ide: host services')
}

/**
 * Node half — host-side lifecycle.
 *
 * Owns the profile seams (storage domain, credential store), publishes the
 * resolved connection specs the MCP server reads, and mounts the panel's HTTP
 * routes on the composition's `webServer`. The host remains the single writer
 * for configuration and secrets (docs/02 §3); unloading releases the service,
 * the runtime spec file, the storage unit and the routes.
 */

import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'

import { registerAgentRoutes } from './host/agent-routes.ts'
import { type AgentRelay, startAgentRelay } from './host/agent-relay.ts'
import { startHostServices } from './host/binding.ts'
import { consoleRegistryPath } from './host/console-registry.ts'
import type { ConnectionService, NodeHostContext, WebServerService } from './host/contract.ts'
import { registerPanelRoutes } from './host/web-routes.ts'

/** Host services this half needs. */
export const inject = ['storageDomain', 'credentials']

/** Everything the panel needs from the node half. */
export const injectOptional = ['webServer', 'connection']

/** Read a service opportunistically; absent is a normal composition. */
function lookup<T>(ctx: NodeHostContext, name: 'webServer' | 'connection'): T | undefined {
  if (typeof ctx.get === 'function') {
    const service = ctx.get(name)
    return service === undefined ? undefined : (service as T)
  }
  // Legacy / test compositions without `ctx.get` expose services as plain properties.
  // Never touch `ctx[name]` when `ctx.get` exists: Cordis 4 throws
  // `cannot get property "<name>" without inject` on uninjected property reads.
  return ctx[name] as T | undefined
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
  let startedPromise: ReturnType<typeof startHostServices> | undefined
  const getStarted = (): ReturnType<typeof startHostServices> => (startedPromise ??= startHostServices(ctx))

  const mountRoutes = async (
    webServer: WebServerService,
    routeCtx: NodeHostContext,
    started: Awaited<ReturnType<typeof startHostServices>>,
  ): Promise<() => Promise<void>> => {
    const resolveConnection = (): ConnectionService | undefined =>
      lookup<ConnectionService>(routeCtx, 'connection') ?? lookup<ConnectionService>(ctx, 'connection')
    // No fence means "the host forgot the trust check", not "anyone on the
    // machine may execute SQL". Resolve `connection` per request so a host
    // that mounts `connection` after this plugin still authorizes callers,
    // while failing closed with 401 whenever `connection` is absent.
    if (resolveConnection() === undefined && typeof ctx.inject !== 'function') {
      console.error('dsh-data-ide: 宿主未提供 connection，面板路由拒绝全部请求（缺少连接信任校验）')
    }
    const fence = (req: IncomingMessage): number | undefined => {
      const connection = resolveConnection()
      return connection === undefined ? 401 : connection.requestRejection(req)
    }
    const unmount = registerPanelRoutes(webServer, started.api, fence)

    // Agent deliveries ride a spool beside the runtime specs the MCP server
    // already reads; without a home path there is nowhere to put it.
    let unmountAgent: (() => void) | undefined
    let relay: AgentRelay | undefined
    const runtimeDir = ctx.dshHomePath?.('data-ide-runtime')
    if (runtimeDir === undefined) {
      console.error('dsh-data-ide: 宿主未提供 dshHomePath，agent 结果投递通道未启用')
    } else {
      relay = await startAgentRelay({ dir: join(runtimeDir, 'agent-outbox') })
      unmountAgent = registerAgentRoutes(webServer, relay, fence, {
        registryPath: consoleRegistryPath(runtimeDir),
      })
    }

    return async () => {
      unmountAgent?.()
      unmount()
      await relay?.dispose()
    }
  }

  ctx.effect(async () => {
    const started = await getStarted()
    if (typeof ctx.inject === 'function') {
      return async () => {
        await started.dispose()
      }
    }

    const webServer = lookup<WebServerService>(ctx, 'webServer')
    if (webServer === undefined) {
      // Fail closed and loudly: without routes the panel can show connections but
      // can neither read nor execute, and that must not be silent.
      console.error('dsh-data-ide: 宿主未提供 webServer，面板无法与后端通信（该 composition 不支持外部路由）')
      return async () => {
        await started.dispose()
      }
    }

    const unmountRoutes = await mountRoutes(webServer, ctx, started)
    return async () => {
      await unmountRoutes()
      await started.dispose()
    }
  }, 'dsh-data-ide: host services')

  if (typeof ctx.inject === 'function') {
    // Register route mounting through Cordis's own dependency child plugin so
    // routes mount cleanly regardless of whether `webServer` starts before or
    // after `dsh-data-ide`, without blocking storage/MCP startup when absent.
    ctx.inject(['webServer'], webCtx => {
      webCtx.effect(async () => {
        const started = await getStarted()
        const webServer = lookup<WebServerService>(webCtx, 'webServer')
        if (webServer === undefined) return
        return mountRoutes(webServer, webCtx, started)
      }, 'dsh-data-ide: panel routes')
    })
  }
}

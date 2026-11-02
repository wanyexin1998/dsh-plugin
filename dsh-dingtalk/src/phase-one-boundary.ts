import type { HostAgentContext } from './host.js'

const installed = new WeakSet<object>()
/** Phase one exposes conversation only in IM. Data and local execution stay in Web.
 * A runtime guard also blocks scoped/preset tools, unlike hiding one tool or Skill.
 * Refuse the turn on hosts without this boundary; never silently degrade.
 */
export function installPhaseOneBoundary(ctx: HostAgentContext): void {
  if (installed.has(ctx)) return
  const tools = ctx.tools as HostAgentContext['tools'] & {
    guard?: (fn: () => string) => () => void
  }
  if (typeof tools.guard !== 'function') throw new Error('phase1_tool_boundary_unavailable')
  tools.guard(() => 'phase1_web_only: 请在 DSH Web 中执行工具或查询个人数据。')
  installed.add(ctx)
}

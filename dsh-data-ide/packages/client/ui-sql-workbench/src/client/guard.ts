import type { ClientContext } from './contract/host.ts'

/**
 * Fail-closed capability check for the right-sidebar host face.
 *
 * dsh gates external plugins on declared peer versions and skips an
 * incompatible bundle outright (`packages/boot/plugin-manager/src/index.ts:301-302`),
 * so a host that still boots this plugin but ships an older sidebar face must
 * degrade loudly instead of failing silently or throwing inside an effect.
 */
export function sidebarRightSupported(ctx: ClientContext): boolean {
  return typeof ctx.sidebarRight?.openTab === 'function' && typeof ctx.sidebarRightTabs?.register === 'function'
}

/** Message shown when the host cannot host the tab. */
export const UNSUPPORTED_REASON =
  'dsh-data-ide: this DeepSeek Harness build has no right-sidebar page-type registry ' +
  '(`sidebarRight` / `sidebarRightTabs`); the SQL workbench tab was not registered. ' +
  'dsh 0.1.7 or newer is required.'

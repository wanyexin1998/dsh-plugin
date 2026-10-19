/**
 * Ambient declarations for the host packages this plugin reads at runtime.
 *
 * These are shipped by the app (they are platform modules), NOT dependencies of this
 * package, so they are declared here and marked `external` in build.mjs — bundling a second
 * copy would break the host singleton rule.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type * as React from 'react'
  export const MenuItemButton: React.ComponentType<{
    separatorBefore?: boolean
    disabled?: boolean
    icon?: React.ReactNode
    onSelect?: () => void
    children?: React.ReactNode
  }>
}

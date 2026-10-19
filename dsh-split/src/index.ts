/**
 * Host half of the workbench plugin.
 *
 * The split view is entirely a browser concern: it renders the shipped Conversation
 * Component Factory once per panel over sessions the client already retains, and keeps
 * its layout in the page's own storage. Nothing is needed from the host, but this half
 * still needs a working `apply` — the client-module scan only walks live, non-disabled
 * Loader entries, so a row without a host implementation would never deliver the
 * browser bundle.
 */

/** Cordis function-plugin name; must equal the package name. */
export const name = 'dsh-split'

/** No host services are read. */
export const inject: string[] = []

/** Activate the row. The browser half carries the whole feature. */
export function apply(): void {}

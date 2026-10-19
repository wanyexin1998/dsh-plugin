/**
 * Host half of dsh-split.
 *
 * The split view is entirely a browser concern: it renders the shipped
 * Conversation Component Factory once per pane over sessions the client already
 * retains, and persists its layout in the page's own storage. Nothing is needed
 * from the host, and no `Config` is exported on purpose — Cordis validates an
 * exported `Config` through its schema object, and this plugin has no host-side
 * tunable to validate.
 *
 * This half still has a working `apply`: the client-module scan only walks live,
 * non-disabled Loader entries, so a row without a host implementation would
 * never deliver the browser bundle.
 */

/** Cordis function-plugin name; must equal the package name and the panel id. */
export const name = 'dsh-split'

/** No host services are read. */
export const inject = []

/** Activate the row. The browser half carries the whole feature. */
export function apply() {}

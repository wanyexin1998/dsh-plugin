/**
 * Host half of dsh-split-probe.
 *
 * The probe is entirely a browser concern: it inspects the client-side contract
 * on the locked rc.2 host and reports what it finds. Nothing is needed from the
 * host, but this half still needs a working `apply`, because the client-module
 * scan only walks live, non-disabled Loader entries — a row without a host
 * implementation would never deliver the browser bundle.
 */

/** Cordis function-plugin name; must equal the package name. */
export const name = 'dsh-split-probe'

/** No host services are read. */
export const inject = []

/** Activate the row. The browser half carries the whole probe. */
export function apply() {}

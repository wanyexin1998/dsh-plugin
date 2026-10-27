/**
 * PoC endpoints stay out of a normal install.
 *
 * A profile patch may still say `pocEnabled: true` for an isolated test, but
 * the running Host ignores that unless it was started with `BOOP_ALLOW_POC=1`.
 * The install steps never set that variable. Host tests set it only for the
 * private DSH_HOME they boot.
 */

export function pocRequested(flag: unknown): boolean {
  return flag === true && process.env.BOOP_ALLOW_POC === '1'
}

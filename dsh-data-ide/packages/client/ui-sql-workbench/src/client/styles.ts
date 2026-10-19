/**
 * Style injection for the client bundle.
 *
 * The host loads a client bundle through `window.__ModuleLoader__` and runs its
 * factory on materialization; CSS is expected to be injected from inside that
 * factory, because a sibling `client.css` file is never fetched by the loader.
 * So the build inlines each stylesheet as text and this module appends it once.
 *
 * Consequence: the default import of a `.css` file is the stylesheet *text*, not
 * a class map — `styles.connectionBar` was `undefined` and the panel rendered
 * unstyled. Components therefore import {@link classes}, a pass-through accessor
 * whose keys are the literal class names used in the stylesheet (this package
 * keeps them unhashed on purpose).
 */

let injected = false

/**
 * Class-name accessor: `classes.pager` → `"pager"`.
 *
 * The stylesheet's selectors are already the identifiers the JSX uses, so the
 * mapping is the identity and no per-class table has to be maintained by hand.
 */
export const classes: Record<string, string> = new Proxy({} as Record<string, string>, {
  get: (_target, key) => String(key),
})

/**
 * Append a stylesheet to the document head, at most once per bundle.
 *
 * @param css - Stylesheet text produced by the build.
 */
export function ensureStyles(css: string): void {
  if (injected || typeof document === 'undefined') return
  const element = document.createElement('style')
  element.setAttribute('data-dsh-data-ide', '')
  element.textContent = css
  document.head.append(element)
  injected = true
}

/** Test seam: forget the injection so a fresh document can be styled. */
export function resetStylesForTests(): void {
  injected = false
}

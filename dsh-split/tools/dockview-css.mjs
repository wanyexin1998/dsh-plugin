/**
 * dockview-core 8.5.1's ESM entry contains no stylesheet. Its styled UMD carries
 * the matching CSS as a JSON string. Read that string without executing the UMD
 * or bundling a second engine, and keep its MIT notice with the injected CSS.
 *
 * @scope confines the upstream selectors to this workbench, including its root.
 * It is supported by Chrome 118+, below build.mjs's existing Chrome 126 target.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

export function readDockviewCss() {
  const packageDir = dirname(require.resolve('dockview-core/package.json'))
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  if (pkg.version !== '8.5.1') {
    throw new Error(`Revalidate Dockview's CSS extraction before upgrading from 8.5.1 to ${pkg.version}`)
  }
  const source = readFileSync(join(packageDir, 'dist/dockview-core.js'), 'utf8')
  const matches = [...source.matchAll(/s\.textContent = ("(?:[^"\\]|\\.)*");/g)]
  if (matches.length !== 1) throw new Error('Expected one Dockview stylesheet literal')
  const css = JSON.parse(matches[0][1])
  for (const selector of ['.dv-split-view-container {', '.dv-view-container .dv-view {', '.dv-groupview {']) {
    if (!css.includes(selector)) throw new Error(`Dockview stylesheet is missing ${selector}`)
  }
  const license = readFileSync(join(packageDir, 'LICENCE.md'), 'utf8')
  return `/*! dockview-core ${pkg.version}\n${license}\n*/\n@scope ([data-dsh-split-workbench]) {\n${css}\n}\n`
}

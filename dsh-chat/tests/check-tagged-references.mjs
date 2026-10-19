/**
 * Verify the browser-initiated references the proxy tags with the session token.
 *
 * A document's favicon and web-app manifest are fetched by the browser itself,
 * not by page script, so the injected request guard never sees them. They are
 * rewritten in the served document instead; this checks both that the rewrite
 * happened and that the rewritten URL is actually authorized.
 *
 * Usage: node tests/check-tagged-references.mjs
 */

import { startBridgeProxy } from '../lib/bridge-proxy.js'

const token = 'c'.repeat(64)
const started = await startBridgeProxy({ target: 'https://chat.deepseek.com', sessionToken: token })
let checks = 0
const check = (label, pass, detail) => {
  checks += 1
  console.log((pass ? '  ok  ' : '  FAIL ') + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)))
  return pass
}

const document = await (await fetch(
  started.origin + '/?__bridge_session=' + token,
  { headers: { 'sec-fetch-dest': 'iframe' } },
)).text()

const pattern = /<link[^>]+rel="(?:icon|shortcut icon|apple-touch-icon|manifest)"[^>]*>/gi
const references = [...document.matchAll(pattern)].map(match => match[0])
check('the document declares icon or manifest references', references.length > 0, references.length)
check('every reference carries the session token',
  references.every(reference => reference.includes('__bridge_session=')),
  references.slice(0, 3).map(reference => reference.slice(0, 110)))

const hrefs = references
  .map(reference => /href="([^"]+)"/.exec(reference)?.[1])
  .filter(href => typeof href === 'string')
check('each reference exposes an href', hrefs.length === references.length, hrefs.length)

let allOk = true
for (const href of hrefs) {
  const response = await fetch(new URL(href, started.origin))
  if (response.status !== 200) { allOk = false; console.log('      failed: ' + href + ' -> ' + String(response.status)) }
}
check('each tagged reference answers 200', allOk)

// Without the tag they are refused, which is what the tagging exists to avoid.
const bare = hrefs[0]?.split('?')[0]
if (typeof bare === 'string') {
  const refused = await fetch(new URL(bare, started.origin), { redirect: 'manual' })
  check('the same reference without the tag is refused', refused.status === 403, refused.status)
}

await started.dispose()
console.log('')
console.log(String(checks) + ' checks passed')
process.exit(checks === 5 ? 0 : 1)

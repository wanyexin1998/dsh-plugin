/**
 * Verify the "open in a real browser window" path, which is the mode the panel
 * falls back to when a cross-site frame cannot hold the bridge's cookie.
 *
 * The path is: the page asks the host for a one-shot ticket, opens the ticket
 * URL in a new browsing context, and the proxy exchanges that ticket for the
 * session cookie and redirects. A real window is a first-party context for the
 * loopback origin, so the cookie survives there.
 *
 * Usage: node tests/verify-external-window.mjs <guiBase> <authToken>
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const EDGE = process.env.DSH_EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const [guiBase, authToken] = process.argv.slice(2)

/** Authorize a bare client the way the desktop document does. */
const authorized = await fetch(guiBase + '/?token=' + authToken, { redirect: 'manual' })
const guiCookie = (authorized.headers.getSetCookie?.() ?? []).map(value => value.split(';', 1)[0]).join('; ')

const ticketResponse = await fetch(guiBase + '/dsh-chat/api/ticket', { method: 'POST', headers: { cookie: guiCookie } })
const ticket = await ticketResponse.json()
const ticketUrl = ticket.url
const bridgeOrigin = new URL(ticketUrl).origin
console.log('ticket url host ok:', ticketUrl.includes('__bridge_ticket=') && ticketUrl.startsWith(bridgeOrigin))
console.log('ticket carries no session token:', ticketUrl.includes('__bridge_session=') === false)

const edge = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dsh-window-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

const endpoint = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error('no devtools endpoint')), 30_000)
  edge.stderr.on('data', chunk => {
    buffer += String(chunk)
    const match = /ws:\/\/[^\s]+/.exec(buffer)
    if (match !== null) { clearTimeout(timer); resolve(match[0]) }
  })
})
const socket = new WebSocket(endpoint)
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
let nextId = 1
const pending = new Map()
const send = (method, params = {}, sessionId) => new Promise(resolve => {
  const id = nextId++
  pending.set(id, { resolve })
  socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
})
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.id === undefined) return
  const entry = pending.get(message.id)
  if (entry !== undefined) { pending.delete(message.id); entry.resolve(message.result) }
})
const evaluate = async (expression, sessionId) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (result.exceptionDetails !== undefined) return { __error: result.exceptionDetails.text }
  return result.result.value
}

const target = await send('Target.createTarget', { url: 'about:blank' })
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
const session = attached.sessionId
await send('Page.enable', {}, session)
await send('Network.enable', {}, session)
await send('Page.navigate', { url: ticketUrl }, session)
await new Promise(resolve => setTimeout(resolve, 14_000))

const state = await evaluate(`(() => ({
  url: location.href,
  title: document.title,
  hasTokenInUrl: location.href.includes('__bridge_session='),
  hasTicketInUrl: location.href.includes('__bridge_ticket='),
  text: (document.body.innerText || '').slice(0, 200),
  refused: /bridge:\\s*(no-session|bad-request|upstream)/.test(document.body.innerText || ''),
  frames: document.querySelectorAll('iframe').length,
}))()`, session)
const cookies = await send('Network.getCookies', { urls: [bridgeOrigin] }, session)
console.log(JSON.stringify({ state, cookies: (cookies.cookies ?? []).map(c => c.name) }, null, 1))
socket.close()
edge.kill()
// The app routes a signed-out visitor to its own sign-in page, so the title is
// the site's full title on some documents and its short one on others; what
// matters is that the bridge served the real app and never refused it.
const served = typeof state.title === 'string' && state.title.includes('DeepSeek')
const cookieStored = (cookies.cookies ?? []).some(c => c.name === 'dsh_bridge_session')
console.log('served by the app:', served, '| session cookie stored:', cookieStored)
const ok = state.refused === false && served && cookieStored && state.hasTicketInUrl === false
console.log(ok ? 'RESULT: the browser window path works' : 'RESULT: the browser window path failed')
process.exit(ok ? 0 : 1)

/**
 * Verify the right sidebar's DeepSeek Chat tab.
 *
 * Registers nothing itself: it drives the shipped UI and asserts the contract the
 * plugin promises there —
 *
 *   - the sidebar foot offers the entry point, and it is enabled only with a
 *     session open (the sidebar renders one session's tabs at a time);
 *   - one click places the tab, and the tab body renders the proxied document
 *     from the loopback bridge, with no bridge refusal and no console error.
 *
 * Usage: node tests/verify-sidebar-tab.mjs <guiBaseUrl> <authToken> [screenshotPath]
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const EDGE = process.env.DSH_EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const [guiBase, authToken, shotPath] = process.argv.slice(2)
if (authToken === undefined) {
  console.error('usage: node tests/verify-sidebar-tab.mjs <guiBaseUrl> <authToken> [screenshotPath]')
  process.exit(2)
}

const edge = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dsh-chat-tab-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1400,900', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
const endpoint = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => { reject(new Error('no devtools endpoint')) }, 30_000)
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
const responses = []
const failures = []
const consoleErrors = []
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
})
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined) {
    const entry = pending.get(message.id)
    if (entry !== undefined) { pending.delete(message.id); entry.resolve(message.result) }
    return
  }
  if (message.method === 'Network.responseReceived') {
    responses.push({ url: message.params.response.url, status: message.params.response.status, type: message.params.type })
  }
  if (message.method === 'Network.loadingFailed') failures.push(message.params)
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ').slice(0, 200))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text).slice(0, 200))
  }
})

const target = await send('Target.createTarget', { url: 'about:blank' })
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
const session = attached.sessionId
await send('Page.enable', {}, session)
await send('Network.enable', {}, session)
await send('Runtime.enable', {}, session)
await send('Page.navigate', { url: `${guiBase}/?token=${authToken}` }, session)
await new Promise(resolve => setTimeout(resolve, 15_000))

let checks = 0
const failed = []
const check = (label, pass, detail) => {
  checks += 1
  if (!pass) failed.push(label)
  console.log((pass ? '  ok  ' : '  FAIL ') + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)))
}
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session)
  if (result.exceptionDetails !== undefined) return { __error: result.exceptionDetails.text }
  return result.result.value
}

// The entry point must exist in the sidebar foot.
const footer = await evaluate(`(() => {
  const el = document.querySelector('[data-bridge-footer-action]');
  if (el === null) return { present: false };
  const r = el.getBoundingClientRect();
  return {
    present: true,
    label: el.getAttribute('aria-label'),
    visible: r.width > 0 && r.height > 0,
    point: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
  };
})()`)
check('the sidebar foot offers the chat entry point', footer.present === true && footer.visible === true, footer)

// Open a session first: the sidebar shows one session's tabs, so a tab can only
// be placed while one is open. Start a New Session, then find its sidebar row.
const opened = await evaluate(`(async () => {
  const button = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('新会话'));
  if (button === undefined) return { started: false, reason: 'no new-session control' };
  button.click();
  return { started: true };
})()`)
check('a session can be started from the sidebar', opened.started === true, opened)
await new Promise(resolve => setTimeout(resolve, 6000))

const footerAfter = await evaluate(`(() => {
  const el = document.querySelector('[data-bridge-footer-action]');
  if (el === null) return { present: false };
  const r = el.getBoundingClientRect();
  return { present: true, point: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } };
})()`)
check('the entry point is still there once a session is open', footerAfter.present === true, footerAfter)

// Click it for real.
if (footerAfter.present === true) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: footerAfter.point.x, y: footerAfter.point.y, button: 'left', clickCount: 1 }, session)
  }
}
await new Promise(resolve => setTimeout(resolve, 6000))

const body = await evaluate(`(() => {
  const body = document.querySelector('[data-bridge-tab]');
  const chip = [...document.querySelectorAll('[data-sidebar-right-tab]')].map(node => (node.textContent || '').trim());
  const frame = document.querySelector('[data-bridge-tab] iframe[data-bridge-frame]');
  return {
    bodyPresent: body !== null,
    bodySize: body === null ? null : { w: Math.round(body.getBoundingClientRect().width), h: Math.round(body.getBoundingClientRect().height) },
    frameSrc: frame === null ? null : frame.getAttribute('src'),
    chips: chip.slice(0, 6),
  };
})()`)
check('the tab body renders', body.bodyPresent === true, body)
check('the tab body hosts the bridged frame', typeof body.frameSrc === 'string' && body.frameSrc.includes('__bridge_session='), body.frameSrc)
check('the tab chip carries the chat title', body.chips.some(text => text.includes('DeepSeek Chat')), body.chips)

// The framed document itself must be served, not refused.
for (let attempt = 0; attempt < 40; attempt += 1) {
  const served = responses.some(entry => entry.url.includes('__bridge_session=') && entry.type === 'Document' && entry.status === 200)
  if (served) break
  await new Promise(resolve => setTimeout(resolve, 500))
}
const documentResponses = responses.filter(entry => entry.url.includes('__bridge_session=') && entry.type === 'Document')
check('the bridge served the framed document', documentResponses.some(entry => entry.status === 200), documentResponses.slice(0, 3))
const refusals = responses.filter(entry => entry.status === 403 && entry.url.includes('__bridge'))
check('the bridge refused nothing in the tab', refusals.length === 0, refusals.slice(0, 3))

if (shotPath !== undefined) {
  await new Promise(resolve => setTimeout(resolve, 4000))
  mkdirSync(dirname(shotPath), { recursive: true })
  const shot = await send('Page.captureScreenshot', { format: 'png' }, session)
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  console.log('wrote ' + shotPath)
}

check('no console error', consoleErrors.length === 0, consoleErrors.slice(0, 4))

console.log('')
console.log(failed.length === 0 ? String(checks) + '/' + String(checks) + ' passed' : JSON.stringify({ failed, passed: String(checks - failed.length) + '/' + String(checks) }))
socket.close()
edge.kill()
process.exit(failed.length === 0 ? 0 : 1)

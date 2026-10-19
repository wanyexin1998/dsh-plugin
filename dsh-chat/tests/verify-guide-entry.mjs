/**
 * Verify the right column's guide card for DeepSeek Chat.
 *
 * The empty right column lists one card per tab type. This asserts the plugin's
 * card is there with its copy and its key, and that picking it opens the chat tab
 * — which is the path a user takes from an empty column.
 *
 * Usage: node tests/verify-guide-entry.mjs <guiBaseUrl> <authToken> [screenshotPath]
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const EDGE = process.env.DSH_EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const [guiBase, authToken, shotPath] = process.argv.slice(2)
if (authToken === undefined) {
  console.error('usage: node tests/verify-guide-entry.mjs <guiBaseUrl> <authToken> [screenshotPath]')
  process.exit(2)
}

const edge = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dsh-chat-guide-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900', 'about:blank',
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
await new Promise(resolve => setTimeout(resolve, 14_000))

let checks = 0
const failed = []
const check = (label, pass, detail) => {
  checks += 1
  if (!pass) failed.push(label)
  console.log((pass ? '  ok  ' + label : '  FAIL ' + label) + (detail === undefined ? '' : '  ' + JSON.stringify(detail)))
}
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session)
  if (result.exceptionDetails !== undefined) return { __error: result.exceptionDetails.text }
  return result.result.value
}

// A session has to exist: the column's tabs belong to one.
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('新会话')); if (b) b.click(); return true })()`)
await new Promise(resolve => setTimeout(resolve, 7000))
// Reveal the right column, whose empty state is the guide.
const revealed = await evaluate(`(() => {
  const el = [...document.querySelectorAll('button, [role="button"]')].find(node => /打开右侧边栏/.test(node.getAttribute('aria-label') || ''));
  if (el === undefined) return false;
  el.click();
  return true;
})()`)
check('the right column can be revealed', revealed === true)
await new Promise(resolve => setTimeout(resolve, 3000))

const card = await evaluate(`(() => {
  const el = document.querySelector('[data-sidebar-right-guide-entry="dsh-chat"]');
  const cards = [...document.querySelectorAll('[data-sidebar-right-guide-entry]')].map(node => node.getAttribute('data-sidebar-right-guide-entry'));
  if (el === null) return { present: false, cards };
  const r = el.getBoundingClientRect();
  return {
    present: true,
    cards,
    title: (el.querySelector('span span') || {}).textContent ?? null,
    text: (el.textContent || '').trim(),
    keys: el.getAttribute('aria-keyshortcuts'),
    hasArtwork: el.querySelector('svg') !== null,
    visible: r.width > 0 && r.height > 0,
    point: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
  };
})()`)
check('the guide offers a card for the chat tab', card.present === true && card.visible === true, { present: card.present, cards: card.cards })
check('the card names the tab', typeof card.text === 'string' && card.text.includes('DeepSeek Chat'), card.text)
check('the card carries its own artwork', card.hasArtwork === true)
check('the card advertises no key it cannot honour', card.keys === null, card.keys)
check('the shipped cards are still listed', Array.isArray(card.cards) && card.cards.length >= 3, card.cards)

if (shotPath !== undefined) {
  mkdirSync(dirname(shotPath), { recursive: true })
  const shot = await send('Page.captureScreenshot', { format: 'png' }, session)
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  console.log('wrote ' + shotPath + ' (the guide, before the pick)')
}

// Picking the card is how a user opens the tab from an empty column.
if (card.present === true) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: card.point.x, y: card.point.y, button: 'left', clickCount: 1 }, session)
  }
}
await new Promise(resolve => setTimeout(resolve, 6000))
const opened = await evaluate(`(() => {
  const body = document.querySelector('[data-bridge-tab]');
  const frame = document.querySelector('[data-bridge-tab] iframe[data-bridge-frame]');
  return {
    bodyPresent: body !== null,
    frameSrc: frame === null ? null : String(frame.getAttribute('src')).slice(0, 70),
    chips: [...document.querySelectorAll('[data-sidebar-right-tab]')].map(node => (node.textContent || '').trim()).slice(0, 4),
  };
})()`)
check('picking the card opens the chat tab', opened.bodyPresent === true, opened)
check('the opened tab frames the bridged document', typeof opened.frameSrc === 'string' && opened.frameSrc.includes('__bridge_session='), opened.frameSrc)

for (let attempt = 0; attempt < 30; attempt += 1) {
  if (responses.some(entry => entry.url.includes('__bridge_session=') && entry.type === 'Document' && entry.status === 200)) break
  await new Promise(resolve => setTimeout(resolve, 500))
}
check('the bridge served the document', responses.some(entry => entry.url.includes('__bridge_session=') && entry.type === 'Document' && entry.status === 200))
check('the bridge refused nothing', responses.filter(entry => entry.status === 403).length === 0)

if (shotPath !== undefined) {
  const after = shotPath.replace(/\.png$/, '-opened.png')
  const shot = await send('Page.captureScreenshot', { format: 'png' }, session)
  writeFileSync(after, Buffer.from(shot.data, 'base64'))
  console.log('wrote ' + after)
}
check('no console error', consoleErrors.length === 0, consoleErrors.slice(0, 3))

console.log('')
console.log(failed.length === 0 ? String(checks) + '/' + String(checks) + ' passed' : JSON.stringify({ failed, passed: String(checks - failed.length) + '/' + String(checks) }))
socket.close()
edge.kill()
process.exit(failed.length === 0 ? 0 : 1)

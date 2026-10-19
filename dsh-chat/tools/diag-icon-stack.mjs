/**
 * Diagnostic: what sits on top of the strip's trailing icons.
 *
 * Usage: node tools/diag-icon-stack.mjs <guiBaseUrl> <authToken>
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const EDGE = process.env.DSH_EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const [guiBase, authToken] = process.argv.slice(2)
const edge = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dsh-chat-stack-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,860', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
const endpoint = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => { reject(new Error('no devtools')) }, 30_000)
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
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
})
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.id === undefined) return
  const entry = pending.get(message.id)
  if (entry !== undefined) { pending.delete(message.id); entry.resolve(message.result) }
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session)
  return result.exceptionDetails === undefined ? result.result.value : { __error: result.exceptionDetails.text }
}

const target = await send('Target.createTarget', { url: 'about:blank' })
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
const session = attached.sessionId
await send('Page.enable', {}, session)
await send('Page.navigate', { url: `${guiBase}/?token=${authToken}` }, session)
await new Promise(resolve => setTimeout(resolve, 13_000))

// Open the chat view, which is what makes the trailing icons exist.
const spot = await evaluate(`(() => {
  const track = document.querySelector('[data-bridge-segment]');
  const r = track.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y }, session)
await new Promise(resolve => setTimeout(resolve, 400))
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1 }, session)
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1 }, session)
await new Promise(resolve => setTimeout(resolve, 3000))

const report = await evaluate(`(() => {
  const strip = document.querySelector('[data-bridge-strip]');
  const actions = document.querySelector('[data-bridge-actions]');
  const buttons = actions === null ? [] : [...actions.querySelectorAll('button')];
  return {
    stripZ: getComputedStyle(strip).zIndex,
    stripPointerEvents: getComputedStyle(strip).pointerEvents,
    actionsRect: actions === null ? null : (() => { const r = actions.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), z: getComputedStyle(actions).zIndex, pe: getComputedStyle(actions).pointerEvents } })(),
    buttons: buttons.map(button => {
      const r = button.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      const chain = [];
      for (let node = hit; node !== null && chain.length < 5; node = node.parentElement) {
        const style = getComputedStyle(node);
        chain.push(node.tagName + '#' + (node.id || '-') + '.' + String(node.className).slice(0, 22) + ' z=' + style.zIndex + ' pe=' + style.pointerEvents);
      }
      return {
        label: button.getAttribute('aria-label'),
        rect: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        point: { x, y },
        hitDescription: hit === null ? null : hit.tagName + '[' + (hit.getAttribute('aria-label') ?? '') + ']',
        hitIsSelf: hit === button || button.contains(hit),
        chain,
      };
    }),
  };
})()`)
console.log(JSON.stringify(report, null, 1))
socket.close()
edge.kill()
process.exit(0)

/**
 * Verify the strip's hit area is the control, not the whole row.
 *
 * The switch floats over the window's chrome band. If that band took pointer
 * input across its width it would swallow every click in the row — including the
 * app's own toolbar buttons — so the interactive part must be the control's own
 * rectangle. This sends a real pointer to points beside the control and asserts
 * the strip stays collapsed and the page underneath still receives the hit.
 *
 * Usage: node tests/verify-strip-hit-area.mjs <guiBaseUrl> <authToken>
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const EDGE = process.env.DSH_EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const [guiBase, authToken] = process.argv.slice(2)

const edge = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dsh-chat-hit-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,860', 'about:blank',
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
  if (result.exceptionDetails !== undefined) return { __error: result.exceptionDetails.text }
  return result.result.value
}

const target = await send('Target.createTarget', { url: 'about:blank' })
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
const session = attached.sessionId
await send('Page.enable', {}, session)
await send('Page.navigate', { url: `${guiBase}/?token=${authToken}` }, session)
await new Promise(resolve => setTimeout(resolve, 14_000))

let checks = 0
const failures = []
const check = (label, pass, detail) => {
  checks += 1
  if (!pass) failures.push(label)
  console.log((pass ? '  ok  ' : '  FAIL ') + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)))
}

/** What the browser reports at a point, plus the strip's current state. */
const probe = (x, y) => evaluate(`(() => {
  const strip = document.querySelector('[data-bridge-strip]');
  const track = document.querySelector('[data-bridge-segment]');
  const hit = document.elementFromPoint(${String(x)}, ${String(y)});
  return {
    x: ${String(x)}, y: ${String(y)},
    expanded: strip.hasAttribute('data-bridge-expanded'),
    hitIsStrip: hit !== null && strip.contains(hit),
    hitDescription: hit === null ? null : hit.tagName + (hit.getAttribute('data-bridge-segment') !== null ? '[segment]' : '') + (hit.hasAttribute('data-bridge-strip') ? '[strip]' : ''),
    trackRect: (() => { const r = track.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } })(),
  };
})()`)

const geometry = await evaluate(`(() => {
  const strip = document.querySelector('[data-bridge-strip]');
  const track = document.querySelector('[data-bridge-segment]');
  const s = strip.getBoundingClientRect(), t = track.getBoundingClientRect();
  return {
    strip: { left: Math.round(s.left), right: Math.round(s.right), top: Math.round(s.top), bottom: Math.round(s.bottom) },
    track: { left: Math.round(t.left), right: Math.round(t.right), top: Math.round(t.top), bottom: Math.round(t.bottom) },
  };
})()`)
console.log('geometry:', JSON.stringify(geometry))
check('the strip spans the window', geometry.strip.left === 0 && geometry.strip.right >= 1200)
check('the control is narrower than the strip', geometry.track.right - geometry.track.left < geometry.strip.right - geometry.strip.left)

/** Move the real pointer, then report where it landed and whether the strip opened. */
async function moveTo(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 700 }, session)
  await new Promise(resolve => setTimeout(resolve, 120))
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, session)
  await new Promise(resolve => setTimeout(resolve, 400))
  return probe(x, y)
}

const farLeft = await moveTo(200, geometry.strip.top + 20)
check('the row left of the control does not open the strip', farLeft.expanded === false, farLeft)
check('the row left of the control is not the strip in hit-testing', farLeft.hitIsStrip === false, farLeft)

const farRight = await moveTo(1180, geometry.strip.top + 20)
check('the row right of the control does not open the strip', farRight.expanded === false, farRight)
check('the row right of the control is not the strip in hit-testing', farRight.hitIsStrip === false, farRight)

const centre = await moveTo(Math.round((geometry.track.left + geometry.track.right) / 2), Math.round((geometry.strip.top + geometry.strip.bottom) / 2))
check('the control itself does open the strip', centre.expanded === true, centre)
check('the control is the strip in hit-testing', centre.hitIsStrip === true, centre)

// The native layer, not the page: `-webkit-app-region` swallows clicks before
// the document sees them, so a `drag` band anywhere over this row would eat the
// app's own top-right controls regardless of `pointer-events`. The band must be
// free of it.
const dragBand = await evaluate(`(() => {
  const strip = document.querySelector('[data-bridge-strip]');
  const s = strip.getBoundingClientRect();
  const owned = new Set([strip, ...strip.querySelectorAll('*')]);
  const offenders = [];
  for (let x = 0; x <= s.width; x += 40) {
    for (let y = s.top + 1; y < s.bottom; y += 8) {
      for (const node of document.elementsFromPoint(x, y)) {
        for (let hop = node, depth = 0; hop !== null && depth < 12; hop = hop.parentElement, depth += 1) {
          if (owned.has(hop)) continue;
          if (getComputedStyle(hop).getPropertyValue('-webkit-app-region') === 'drag') {
            const label = hop.tagName + '.' + String(hop.className).slice(0, 24);
            if (!offenders.includes(label)) offenders.push(label);
          }
        }
      }
    }
  }
  return { offenders, sample: { x: 0, y: Math.round(s.top) + 1 } };
})()`)
check('nothing in the row claims the native drag region', dragBand.offenders.length === 0, dragBand.offenders)

// Leaving the control must close it again.
const away = await moveTo(300, 500)
check('leaving the control closes the strip', away.expanded === false, away)

console.log('')
console.log(failures.length === 0 ? String(checks) + ' checks passed' : 'failed: ' + failures.join('; '))
socket.close()
edge.kill()
process.exit(failures.length === 0 ? 0 : 1)

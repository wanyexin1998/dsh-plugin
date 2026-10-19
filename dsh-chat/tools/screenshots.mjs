/**
 * Capture the delivery screenshots from a running DSH instance.
 *
 * Four files land in the output directory:
 *
 *   arrow-collapsed.png     the collapsed strip: only the little arrow shows
 *   panel-conversation.png  the strip expanded over the conversation view
 *   switch-zoom.png         a 4x crop of the switch, to compare with the design
 *   panel-chat.png          the chat panel with the framed DeepSeek web app
 *
 * Usage: node tools/screenshots.mjs <guiBaseUrl> <authToken> <outDir>
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const EDGE = process.env.DSH_EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const [guiBase, authToken, outDir] = process.argv.slice(2)
if (outDir === undefined) {
  console.error('usage: node tools/screenshots.mjs <guiBaseUrl> <authToken> <outDir>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

const edge = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dsh-chat-shot-'))}`,
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

const target = await send('Target.createTarget', { url: 'about:blank' })
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
const session = attached.sessionId
await send('Page.enable', {}, session)
await send('Page.navigate', { url: `${guiBase}/?token=${authToken}` }, session)
await new Promise(resolve => setTimeout(resolve, 13_000))

/** Evaluate in the page and return the value, or null when the read failed. */
async function probe(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true }, session)
  return result.exceptionDetails === undefined ? result.result.value : null
}

/**
 * Move the real pointer onto the strip so it expands.
 *
 * The strip is collapsed until the pointer is on it, so every expanded capture
 * has to follow this. The point comes from the strip's own box: its position is
 * a property of the layout, not a number this tool should assume.
 */
async function hoverStrip() {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 400 }, session)
  const spot = await probe(`(() => {
    const bar = document.querySelector('[data-bridge-strip]');
    if (bar === null) return null;
    const r = bar.getBoundingClientRect();
    return { x: Math.round(innerWidth / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
  if (spot !== null) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y }, session)
  }
  await new Promise(resolve => setTimeout(resolve, 450))
}

/** Move the real pointer away, so the strip collapses again. */
async function leaveStrip() {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 600 }, session)
  await new Promise(resolve => setTimeout(resolve, 450))
}

/** Write one capture, hovering the strip first unless the state is collapsed. */
async function shot(name, { expanded = true, clip } = {}) {
  if (expanded) await hoverStrip()
  else await leaveStrip()
  const options = clip === undefined ? { format: 'png' } : { format: 'png', clip }
  const result = await send('Page.captureScreenshot', options, session)
  writeFileSync(join(outDir, name), Buffer.from(result.data, 'base64'))
  console.log('wrote', join(outDir, name))
}

await shot('arrow-collapsed.png', { expanded: false })
await shot('panel-conversation.png')

// A 4x crop of the switch, so its shape can be compared with the design at the
// size a person actually looks at it.
await hoverStrip()
const clip = await probe(`(() => {
  const track = document.querySelector('[data-bridge-segment]');
  if (track === null) return null;
  const r = track.getBoundingClientRect();
  return { x: r.left - 10, y: r.top - 10, width: r.width + 20, height: r.height + 30 };
})()`)
if (clip !== null) await shot('switch-zoom.png', { clip: { ...clip, scale: 4 } })

// Open the chat view through the switch itself, then wait for the framed app.
await hoverStrip()
await probe(`(() => {
  const tab = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '聊天');
  if (tab === undefined) return 'no-tab';
  tab.click();
  return 'clicked';
})()`)
for (let attempt = 0; attempt < 60; attempt += 1) {
  const frames = await probe(`document.querySelectorAll('iframe[title="DeepSeek Chat"]').length`)
  if (typeof frames === 'number' && frames > 0) break
  await new Promise(resolve => setTimeout(resolve, 500))
}
await new Promise(resolve => setTimeout(resolve, 15_000))
await shot('panel-chat.png')

socket.close()
edge.kill()
process.exit(0)

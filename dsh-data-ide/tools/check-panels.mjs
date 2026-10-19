/**
 * Real-machine check for the three-pane layout.
 *
 * jsdom cannot verify any of this: the panels are sized by CSS grid, the sashes
 * are 8px of empty space, and the whole point is that dragging them reflows the
 * DOM. This script measures the live geometry, drags both sashes, and reports
 * whether the panels actually moved.
 *
 * Usage:
 *   node tools/check-panels.mjs --url <tokenized harness url> [--port 9227] [--shot out.png]
 *
 * Exit codes: 0 three panels + two working sashes, 1 geometry wrong,
 * 2 environment problem (panel never rendered).
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const option = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

const url = option('url')
const port = option('port') ?? '9227'
const shot = option('shot')
const chrome = option('chrome')
  ?? process.env['CHROME_PATH']
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

if (url === undefined) {
  console.error('usage: node tools/check-panels.mjs --url <tokenized url> [--port 9227] [--shot out.png]')
  process.exit(2)
}

async function startChrome() {
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-proxy-server',
    '--no-first-run',
    '--window-size=1400,900',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env['TEMP'] ?? '/tmp'}/dsh-data-ide-panels-${Date.now()}`,
    'about:blank',
  ], { stdio: 'ignore' })

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return child
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  child.kill()
  throw new Error('chrome did not expose a debugging port')
}

async function connect(pageUrl) {
  const target = await (await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(pageUrl)}`,
    { method: 'PUT' },
  )).json()

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  const events = []
  let id = 0

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) {
      events.push(message)
      return
    }
    const settle = pending.get(message.id)
    if (settle !== undefined) {
      pending.delete(message.id)
      settle(message)
    }
  })

  const send = (method, params = {}) => new Promise(resolve => {
    const messageId = ++id
    pending.set(messageId, resolve)
    socket.send(JSON.stringify({ id: messageId, method, params }))
  })

  const evaluate = async expression => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const details = reply.result?.exceptionDetails
    if (details !== undefined) throw new Error(`page evaluation failed: ${details.text}`)
    return reply.result?.result?.value
  }

  return { socket, send, evaluate, events }
}

/** Current panel boxes, keyed by `data-sql-panel`. */
const measure = `(() => {
  const box = element => element === null ? null : {
    x: Math.round(element.getBoundingClientRect().left),
    y: Math.round(element.getBoundingClientRect().top),
    w: element.clientWidth,
    h: element.clientHeight,
  }
  const panel = id => box(document.querySelector('[data-sql-panel="' + id + '"]'))
  return {
    objects: panel('objects'),
    editor: panel('editor'),
    result: panel('result'),
    workspace: box(document.querySelector('[data-sql-workspace]')),
    columns: getComputedStyle(document.querySelector('[data-sql-workspace]')).gridTemplateColumns,
    rows: getComputedStyle(document.querySelector('[data-sql-pane-column]')).gridTemplateRows,
    sashes: [...document.querySelectorAll('[data-sql-splitter]')].map(sash => ({
      orientation: sash.getAttribute('data-sql-splitter'),
      ...box(sash),
    })),
  }
})()`

/** Drag a sash by (dx, dy) using real pointer events at its centre. */
const dragSash = (orientation, dx, dy) => `(async () => {
  const sash = document.querySelector('[data-sql-splitter="' + ${JSON.stringify(orientation)} + '"]')
  const rect = sash.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const event = (type, extra) => sash.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x + extra.dx, clientY: y + extra.dy }))
  event('pointerdown', { dx: 0, dy: 0 })
  event('pointermove', { dx: ${dx} / 2, dy: ${dy} / 2 })
  event('pointermove', { dx: ${dx}, dy: ${dy} })
  event('pointerup', { dx: ${dx}, dy: ${dy} })
  await new Promise(resolve => setTimeout(resolve, 250))
  return true
})()`

const browser = await startChrome()
const session = await connect(url)
await session.send('Runtime.enable')
await session.send('Page.enable')
await sleep(7000)

await session.evaluate(`document.querySelector('[aria-label="打开右侧边栏"]')?.click()`)
await sleep(1500)
await session.evaluate(`(() => {
  const button = [...document.querySelectorAll('button,[role="button"],[role="tab"]')]
    .find(node => /SQL/i.test((node.getAttribute('aria-label') ?? '') + (node.getAttribute('title') ?? '') + node.textContent))
  if (button !== undefined) button.click()
  return button !== undefined
})()`)
await sleep(4500)

if (await session.evaluate(`document.querySelector('[data-sql-workspace]') === null`)) {
  console.error('three-pane workspace never rendered')
  session.socket.close()
  browser.kill()
  process.exit(2)
}

const initial = await session.evaluate(measure)
await session.evaluate(dragSash('vertical', 80, 0))
const afterWide = await session.evaluate(measure)
await session.evaluate(dragSash('horizontal', 0, 60))
const afterTall = await session.evaluate(measure)

if (shot !== undefined) {
  const capture = await session.send('Page.captureScreenshot', { format: 'png' })
  if (capture.result?.data !== undefined) writeFileSync(shot, Buffer.from(capture.result.data, 'base64'))
}

const facts = {
  initial,
  afterWide: { columns: afterWide.columns, objects: afterWide.objects, editor: afterWide.editor },
  afterTall: { rows: afterTall.rows, editor: afterTall.editor, result: afterTall.result },
  errors: session.events
    .filter(event => event.method === 'Runtime.exceptionThrown')
    .map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text)
    .filter(line => /dsh-data-ide/i.test(String(line))),
}
console.log(JSON.stringify(facts, null, 2))

session.socket.close()
browser.kill()

const laidOut = initial.objects !== null && initial.editor !== null && initial.result !== null
const stacked = initial.editor !== null && initial.result !== null && initial.editor.y < initial.result.y
const railOnLeft = initial.objects !== null && initial.editor !== null && initial.objects.x < initial.editor.x
const grewWider = afterWide.objects !== null && initial.objects !== null && afterWide.objects.w > initial.objects.w
const grewTaller = afterTall.editor !== null && initial.editor !== null && afterTall.editor.h > initial.editor.h
process.exit(laidOut && stacked && railOnLeft && grewWider && grewTaller ? 0 : 1)

/**
 * Headless smoke check for the SQL workbench pane.
 *
 * Boots a throwaway Chrome against a running harness instance, opens the right
 * sidebar, opens the SQL tab and reports what actually rendered — plus any
 * page error. This is the check that proves the three halves agree (node
 * service, HTTP routes, client seats) without a human looking at the screen.
 *
 * Usage:
 *   node tools/smoke-panel.mjs --url <tokenized harness url> [--port 9223] [--shot out.png] [--chrome <path>]
 *
 * Exit codes: 0 rendered, 1 not rendered, 2 environment problem.
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
const port = option('port') ?? '9223'
const shot = option('shot')
const chrome = option('chrome')
  ?? process.env['CHROME_PATH']
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

if (url === undefined) {
  console.error('usage: node tools/smoke-panel.mjs --url <tokenized url> [--port 9223] [--shot out.png]')
  process.exit(2)
}

/** Start Chrome with a debugging port and wait until it answers. */
async function startChrome() {
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-proxy-server',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env['TEMP'] ?? '/tmp'}/dsh-data-ide-smoke-${Date.now()}`,
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

/** One CDP session over a WebSocket. */
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
    if (reply.result?.exceptionDetails !== undefined) {
      throw new Error(`page evaluation failed: ${reply.result.exceptionDetails.text}`)
    }
    return reply.result?.result?.value
  }

  return { socket, send, evaluate, events }
}

const browser = await startChrome()
const session = await connect(url)
await session.send('Runtime.enable')
await session.send('Log.enable')
await session.send('Page.enable')
await sleep(7000)

await session.evaluate(`(() => {
  const button = document.querySelector('[aria-label="打开右侧边栏"]')
  if (button !== null) button.click()
})()`)
await sleep(2000)

const opened = await session.evaluate(`(() => {
  const button = [...document.querySelectorAll('button,[role="button"],[role="tab"]')]
    .find(node => /SQL/i.test((node.getAttribute('aria-label') ?? '') + (node.getAttribute('title') ?? '') + node.textContent))
  if (button === undefined) return false
  button.click()
  return true
})()`)

if (!opened) {
  console.error('SQL 工作台 launcher not found — the tab type is not registered')
  session.socket.close()
  browser.kill()
  process.exit(1)
}

await sleep(4000)

const facts = await session.evaluate(`(() => {
  const panel = document.querySelector('[data-sql-workbench]')
  const overlay = document.getElementById('dsh-data-ide-diagnostics')
  return {
    panelFound: panel !== null,
    phase: panel?.getAttribute('data-phase') ?? null,
    text: (panel?.innerText ?? '').slice(0, 300),
    overlay: overlay?.textContent?.slice(0, 400) ?? null,
  }
})()`)

const errors = session.events
  .filter(event => event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled')
  .map(event => event.method === 'Runtime.exceptionThrown'
    ? event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text
    : event.params.args.map(argument => argument.value ?? argument.description ?? argument.type).join(' '))
  .filter(line => /dsh-data-ide|inject|slot/i.test(String(line)))

if (shot !== undefined) {
  const capture = await session.send('Page.captureScreenshot', { format: 'png' })
  if (capture.result?.data !== undefined) writeFileSync(shot, Buffer.from(capture.result.data, 'base64'))
}

console.log(JSON.stringify({ ...facts, errors }, null, 2))
session.socket.close()
browser.kill()
process.exit(facts.panelFound ? 0 : 1)

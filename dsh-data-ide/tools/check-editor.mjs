/**
 * Real-machine check for the CodeMirror editor.
 *
 * jsdom can mount a CodeMirror view (with `Range.getClientRects` stubbed), but it
 * cannot type into it, cannot open the completion popup and cannot lay anything
 * out. So the parts that matter are verified here, against a live harness:
 * the view mounts, typing lands in the document, `Ctrl+Enter` runs the statement,
 * the completion popup offers keywords, and `Ctrl+F` opens the search panel.
 *
 * Usage:
 *   node tools/check-editor.mjs --url <tokenized harness url> [--port 9228] [--shot out.png]
 *
 * Exit codes: 0 everything observed, 1 something is off, 2 the panel never opened.
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
const port = option('port') ?? '9228'
const shot = option('shot')
const chrome = option('chrome')
  ?? process.env['CHROME_PATH']
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

if (url === undefined) {
  console.error('usage: node tools/check-editor.mjs --url <tokenized url> [--port 9228] [--shot out.png]')
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
    `--user-data-dir=${process.env['TEMP'] ?? '/tmp'}/dsh-data-ide-editor-${Date.now()}`,
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

  /** Poll until `expression` is truthy; the panel opens on its own schedule. */
  const waitFor = async (expression, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await evaluate(expression) === true) return true
      await sleep(250)
    }
    return false
  }

  return { socket, send, evaluate, waitFor, events }
}

const browser = await startChrome()
const session = await connect(url)
await session.send('Runtime.enable')
await session.send('Page.enable')
await sleep(7000)

// Reach the panel regardless of where the harness lands: home screen → session →
// right sidebar → SQL tab. Every step polls, because each one loads asynchronously.
const clickWhenReady = async (expression, label, timeoutMs = 25000) => {
  // The expression yields a DOM node; `waitFor` needs a boolean.
  if (!await session.waitFor(`Boolean(${expression})`, timeoutMs)) throw new Error(`timed out waiting for ${label}`)
  const clicked = await session.evaluate(`(() => {
    const node = ${expression}
    if (node === null || node === undefined) return false
    node.click()
    return true
  })()`)
  if (clicked !== true) throw new Error(`could not click ${label}`)
}

// 1. The sidebar button exists even on the home screen, but its tabs are
//    session-scoped — so a session has to exist before the SQL tab can.
if (await session.evaluate(`document.querySelector('[data-sql-workbench]') === null`)) {
  await clickWhenReady(`document.querySelector('[aria-label="新建会话"]')`, 'the new-session button')
  await sleep(2500)
}

// 2. Open the right sidebar, then the SQL tab.
await clickWhenReady(`document.querySelector('[aria-label="打开右侧边栏"]')`, 'the right sidebar button')
await sleep(1200)
await clickWhenReady(
  `[...document.querySelectorAll('button,[role="button"],[role="tab"]')].find(node => /SQL/i.test((node.getAttribute('aria-label') ?? '') + (node.getAttribute('title') ?? '') + node.textContent)) ?? null`,
  'the SQL workbench tab',
)

if (!await session.waitFor(`document.querySelector('[data-sql-editor] .cm-content') !== null`, 25000)) {
  console.error('the SQL panel (or its editor) never appeared')
  session.socket.close()
  browser.kill()
  process.exit(2)
}

const mounted = await session.evaluate(`(() => {
  const host = document.querySelector('[data-sql-editor]')
  return {
    editor: host !== null,
    cmEditor: document.querySelector('.cm-editor') !== null,
    gutter: document.querySelector('.cm-gutters') !== null,
    foldGutter: document.querySelector('.cm-foldGutter') !== null,
    activeLine: document.querySelector('.cm-activeLine') !== null,
    textareaGone: document.querySelector('textarea') === null,
    height: host === null ? null : host.clientHeight,
  }
})()`)

// Type through the browser's own input path, so IME-ish insertion is exercised.
await session.evaluate(`(() => {
  const content = document.querySelector('.cm-content')
  if (content === null) return false
  content.focus()
  return true
})()`)
await session.send('Input.insertText', { text: 'select 1 as a' })
await sleep(600)
const typed = await session.evaluate(`(() => ({
  text: [...document.querySelectorAll('.cm-line')].map(node => node.textContent).join(String.fromCharCode(10)),
  tokens: document.querySelectorAll('.cm-line span').length,
}))()`)

await session.evaluate(`document.querySelector('.cm-content')?.dispatchEvent(
  new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) ?? null`)
await sleep(4500)
const ran = await session.evaluate(`(() => ({
  grid: document.querySelector('[data-grid-state]')?.getAttribute('data-grid-state') ?? null,
  count: document.querySelector('[data-grid-count]')?.textContent ?? null,
  header: document.querySelector('[data-sql-panel="result"] th')?.textContent ?? null,
}))()`)

// Completion: a fresh word should pop the list.
await session.evaluate(`(() => {
  const content = document.querySelector('.cm-content')
  if (content === null) return false
  content.focus()
  return true
})()`)
await session.send('Input.insertText', { text: '\nsel' })
await sleep(1000)
const completion = await session.evaluate(`(() => ({
  popup: document.querySelector('.cm-tooltip-autocomplete') !== null,
  options: document.querySelectorAll('.cm-tooltip-autocomplete li').length,
  first: document.querySelector('.cm-tooltip-autocomplete li')?.textContent ?? null,
}))()`)

// Search panel, and its Chinese labels.
await session.evaluate(`document.querySelector('.cm-content')?.dispatchEvent(
  new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })) ?? null`)
await sleep(600)
const search = await session.evaluate(`(() => {
  const panel = document.querySelector('.cm-search')
  return {
    open: panel !== null,
    labels: panel === null ? [] : [...panel.querySelectorAll('button, label')].map(node => node.textContent?.trim()).slice(0, 8),
  }
})()`)

if (shot !== undefined) {
  const capture = await session.send('Page.captureScreenshot', { format: 'png' })
  if (capture.result?.data !== undefined) writeFileSync(shot, Buffer.from(capture.result.data, 'base64'))
}

const facts = {
  mounted,
  typed,
  ran,
  completion,
  search,
  errors: session.events
    .filter(event => event.method === 'Runtime.exceptionThrown')
    .map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text)
    .filter(line => /dsh-data-ide|CodeMirror/i.test(String(line))),
}
console.log(JSON.stringify(facts, null, 2))

session.socket.close()
browser.kill()

const ok = mounted.cmEditor
  && mounted.gutter
  && mounted.textareaGone
  && typed.text.includes('select 1')
  && ran.grid !== null
  && completion.popup
  && search.open
  && search.labels.includes('查找')
process.exit(ok ? 0 : 1)

/**
 * Real-machine check: a run stays in the console that started it.
 *
 * Reported 2026-10-19 — "我在 console2 执行的查询结果还是在 console1 的查询区页面".
 * The write used to resolve against whichever tab was active when the answer
 * arrived, so switching consoles mid-flight moved the rows. This script makes the
 * race deterministic by delaying `/dsh-data-ide/execute` in the page, then does
 * exactly what a person does: run in console_2, click console_1, wait.
 *
 * Usage:
 *   node tools/check-console-pinning.mjs --url <tokenized harness url> [--port 9224] [--shot out.png]
 *
 * Exit codes: 0 pinned correctly, 1 the result leaked, 2 environment problem.
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
const port = option('port') ?? '9224'
const shot = option('shot')
const chrome = option('chrome')
  ?? process.env['CHROME_PATH']
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

if (url === undefined) {
  console.error('usage: node tools/check-console-pinning.mjs --url <tokenized url> [--port 9224]')
  process.exit(2)
}

/** Statement that a stale write would leak visibly. */
const PROBE = 'SELECT 424242 AS pin_probe'
/** How long the faked execute takes; long enough to click another tab. */
const DELAY_MS = 2500

async function startChrome() {
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-proxy-server',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env['TEMP'] ?? '/tmp'}/dsh-data-ide-pin-${Date.now()}`,
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

/** Everything the panel renders for the console that is on screen. */
const visibleState = `(() => {
  const panel = document.querySelector('[data-sql-workbench]')
  const tabs = [...document.querySelectorAll('[data-sql-documents] [role="tab"]')]
  const active = tabs.find(tab => tab.getAttribute('aria-selected') === 'true')
  const textarea = document.querySelector('[data-sql-workbench] textarea')
  return {
    active: active?.textContent ?? null,
    titles: tabs.map(tab => (tab.textContent ?? '').replace(/\\s+/g, ' ').trim()),
    sql: textarea?.value ?? null,
    text: panel?.innerText ?? '',
  }
})()`

const browser = await startChrome()
const session = await connect(url)
await session.send('Runtime.enable')
await session.send('Page.enable')
await sleep(7000)

// Make the race deterministic: every execute answers DELAY_MS late.
await session.evaluate(`(() => {
  const original = window.fetch
  window.fetch = async (input, init) => {
    const target = typeof input === 'string' ? input : (input?.url ?? '')
    if (target.includes('/dsh-data-ide/execute')) {
      await new Promise(resolve => setTimeout(resolve, ${DELAY_MS}))
    }
    return original(input, init)
  }
  return true
})()`)

await session.evaluate(`(() => {
  const button = document.querySelector('[aria-label="打开右侧边栏"]')
  if (button !== null) button.click()
})()`)
await sleep(2000)

await session.evaluate(`(() => {
  const button = [...document.querySelectorAll('button,[role="button"],[role="tab"]')]
    .find(node => /SQL/i.test((node.getAttribute('aria-label') ?? '') + (node.getAttribute('title') ?? '') + node.textContent))
  if (button !== undefined) button.click()
  return button !== undefined
})()`)
await sleep(4500)

const ready = await session.evaluate(`document.querySelector('[data-sql-workbench]') !== null`)
if (!ready) {
  console.error('SQL panel never rendered — rerun tools/smoke-panel.mjs first')
  session.socket.close()
  browser.kill()
  process.exit(2)
}

const click = label => session.evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})
  if (node === null) return false
  node.click()
  return true
})()`)

// console_1 exists; open console_2 and run the probe there.
const created = await click('新建查询标签')
if (!created) {
  console.error('new-console button missing')
  session.socket.close()
  browser.kill()
  process.exit(2)
}
await sleep(500)

await session.evaluate(`(() => {
  const textarea = document.querySelector('[data-sql-workbench] textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(textarea, ${JSON.stringify(PROBE)})
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  return textarea.value
})()`)
await sleep(300)

// Run, then immediately go back to the first console, still in flight.
await click('执行')
await sleep(150)
const switched = await session.evaluate(`(() => {
  const first = document.querySelectorAll('[data-sql-documents] [role="tab"]')[0]
  if (first === null) return false
  first.click()
  return true
})()`)
await sleep(DELAY_MS + 2500)

const consoleOne = await session.evaluate(visibleState)
await session.evaluate(`(() => {
  const tabs = document.querySelectorAll('[data-sql-documents] [role="tab"]')
  tabs[tabs.length - 1]?.click()
  return true
})()`)
await sleep(600)
const consoleTwo = await session.evaluate(visibleState)

/** Click each console in turn and read what it actually holds. */
async function perConsole() {
  const count = await session.evaluate(`document.querySelectorAll('[data-sql-documents] [role="tab"]').length`)
  const seen = []
  for (let index = 0; index < count; index += 1) {
    await session.evaluate(`(() => {
      document.querySelectorAll('[data-sql-documents] [role="tab"]')[${index}]?.click()
      return true
    })()`)
    await sleep(400)
    seen.push(await session.evaluate(visibleState))
  }
  return seen.map(state => ({
    active: state.active,
    sql: state.sql,
    hasResult: state.text.includes('424242'),
  }))
}

const consoles = await perConsole()

if (shot !== undefined) {
  const capture = await session.send('Page.captureScreenshot', { format: 'png' })
  if (capture.result?.data !== undefined) writeFileSync(shot, Buffer.from(capture.result.data, 'base64'))
}

const consoleOneLeaked = consoleOne.text.includes('424242') || (consoleOne.sql ?? '').includes('pin_probe')
const consoleTwoHas = consoleTwo.text.includes('424242')

const facts = {
  probe: PROBE,
  switchedBackToFirstConsole: switched,
  console1: { active: consoleOne.active, sql: consoleOne.sql, leakedProbe: consoleOneLeaked },
  console2: { active: consoleTwo.active, sql: consoleTwo.sql, hasResult: consoleTwoHas },
  consoles,
  errors: session.events
    .filter(event => event.method === 'Runtime.exceptionThrown')
    .map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text)
    .filter(line => /dsh-data-ide/i.test(String(line))),
}
console.log(JSON.stringify(facts, null, 2))

session.socket.close()
browser.kill()
process.exit(!consoleOneLeaked && consoleTwoHas ? 0 : 1)

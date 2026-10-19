/**
 * Real-machine check for the object browser (batch 4).
 *
 * Opens the SQL panel, expands the object tree, and exercises the two actions
 * that touch the database: `Go to DDL` (SHOW CREATE …) and `Edit Data`
 * (SELECT * … LIMIT). Prints what the tree actually shows so the hierarchy can
 * be eyeballed from the JSON, and takes a screenshot of the open menu.
 *
 * Usage:
 *   node tools/check-object-tree.mjs --url <tokenized harness url> [--port 9225] [--shot out.png]
 *
 * Exit codes: 0 the tree rendered and both actions worked, 1 something was
 * missing, 2 environment problem (no panel, no table to click).
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
const port = option('port') ?? '9225'
const shot = option('shot')
const chrome = option('chrome')
  ?? process.env['CHROME_PATH']
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

if (url === undefined) {
  console.error('usage: node tools/check-object-tree.mjs --url <tokenized url> [--port 9225] [--shot out.png]')
  process.exit(2)
}

async function startChrome() {
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-proxy-server',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env['TEMP'] ?? '/tmp'}/dsh-data-ide-tree-${Date.now()}`,
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

const browser = await startChrome()
const session = await connect(url)
await session.send('Runtime.enable')
await session.send('Page.enable')
await sleep(7000)

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

if (await session.evaluate(`document.querySelector('[data-sql-workbench]') === null`)) {
  console.error('SQL panel never rendered')
  session.socket.close()
  browser.kill()
  process.exit(2)
}

// Open the object browser and let the schema read land.
await session.evaluate(`(() => {
  // The object browser is the left panel and starts open; reopen it if a
  // previous step collapsed it.
  const rail = document.querySelector('[aria-label="展开对象树"]')
  if (rail !== null) rail.click()
  return true
})()`)
await sleep(4000)

const tree = await session.evaluate(`(() => {
  const root = document.querySelector('[data-sql-schema-tree]')
  const schemas = [...document.querySelectorAll('[data-sql-schema]')].map(node => node.getAttribute('data-sql-schema'))
  const objects = [...document.querySelectorAll('[data-sql-schema-object]')].map(node => node.getAttribute('data-sql-schema-object'))
  return {
    found: root !== null,
    caption: document.querySelector('[data-sql-schema-root]')?.textContent ?? null,
    summary: document.querySelector('[data-sql-panel-meta="objects"]')?.textContent ?? null,
    schemas,
    objects: objects.slice(0, 12),
    folders: [...root.querySelectorAll('[class*=schemaFolder]')].map(node => node.textContent.replace(/\\s+/g, ' ').trim()),
    note: document.querySelector('[data-sql-schema-note]')?.textContent ?? null,
  }
})()`)

if (!tree.found || tree.objects.length === 0) {
  console.log(JSON.stringify({ tree, reason: '对象树没有可点的表（连接下没有表，或表结构读取失败）' }, null, 2))
  session.socket.close()
  browser.kill()
  process.exit(1)
}

/** Right-click the first table; the menu is rendered by React on the next frame. */
const openMenuOnFirstObject = `(() => {
  const node = document.querySelector('[data-sql-schema-object]')
  const box = node.getBoundingClientRect()
  node.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true,
    clientX: Math.round(box.left + 24), clientY: Math.round(box.top + 8),
  }))
  return true
})()`

await session.evaluate(openMenuOnFirstObject)
await sleep(600)
const menu = await session.evaluate(`(() => {
  const menu = document.querySelector('[data-sql-schema-menu]')
  return {
    opened: menu !== null,
    title: menu?.querySelector('[class*=schemaMenuTitle]')?.textContent ?? null,
    items: [...(menu?.querySelectorAll('[data-sql-menu-item]') ?? [])].map(item => item.getAttribute('data-sql-menu-item')),
    labels: [...(menu?.querySelectorAll('[data-sql-menu-item]') ?? [])].map(item => item.textContent.trim()),
  }
})()`)

if (shot !== undefined) {
  const capture = await session.send('Page.captureScreenshot', { format: 'png' })
  if (capture.result?.data !== undefined) writeFileSync(shot, Buffer.from(capture.result.data, 'base64'))
}

// Go to DDL: the panel runs SHOW CREATE through the execute route (raw mode).
await session.evaluate(`document.querySelector('[data-sql-menu-item="ddl"]')?.click()`)
await sleep(3500)
const ddl = await session.evaluate(`(() => {
  const card = document.querySelector('[data-sql-ddl]')
  return {
    opened: card !== null,
    title: card?.querySelector('[class*=schemaDdlTitle]')?.textContent ?? null,
    text: (card?.querySelector('[class*=schemaDdlBody]')?.textContent ?? '').slice(0, 120),
    error: card?.querySelector('[class*=schemaDdlError]')?.textContent ?? null,
  }
})()`)
await session.evaluate(`document.querySelector('[aria-label="关闭 DDL"]')?.click()`)
await sleep(400)

// Edit Data: fills the console with SELECT * … LIMIT and runs it.
await session.evaluate(openMenuOnFirstObject)
await sleep(600)
const edited = await session.evaluate(`(() => {
  const item = document.querySelector('[data-sql-menu-item="data"]')
  if (item === null) return { clicked: false }
  item.click()
  return { clicked: true }
})()`)
await sleep(3500)
const consoleAfter = await session.evaluate(`(() => {
  const panel = document.querySelector('[data-sql-workbench]')
  return {
    sql: panel?.querySelector('textarea')?.value ?? null,
    grid: panel?.querySelector('[data-grid-state]')?.getAttribute('data-grid-state') ?? null,
    rows: panel?.querySelector('[data-grid-count]')?.textContent ?? null,
  }
})()`)

const facts = {
  tree,
  menu,
  ddl,
  editData: { ...edited, ...consoleAfter },
  errors: session.events
    .filter(event => event.method === 'Runtime.exceptionThrown')
    .map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text)
    .filter(line => /dsh-data-ide/i.test(String(line))),
}
console.log(JSON.stringify(facts, null, 2))

session.socket.close()
browser.kill()
const ok = menu.opened
  && menu.items.includes('ddl')
  && menu.items.includes('data')
  && ddl.opened
  && (ddl.text !== '' || ddl.error !== null)
  && (consoleAfter.sql ?? '').toUpperCase().includes('SELECT')
process.exit(ok ? 0 : 1)

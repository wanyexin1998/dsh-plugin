/**
 * Real-machine check for the result-grid batch: status-bar aggregates,
 * windowed rows and the value viewer.
 *
 * The numbers that matter here cannot be produced by jsdom: how many `<tr>`
 * nodes a 5000-row page actually puts in the document, and whether scrolling
 * moves the window instead of the whole page. This script drives a headless
 * Chrome against a live harness, runs a narrow-but-long query, and reports what
 * the DOM contains.
 *
 * Usage:
 *   node tools/check-grid-batch5.mjs --url <tokenized harness url> [--port 9226] [--shot out.png]
 *
 * Exit codes: 0 all three behaviours observed, 1 one of them is wrong,
 * 2 environment problem (panel or grid never appeared).
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
const port = option('port') ?? '9226'
const shot = option('shot')
const chrome = option('chrome')
  ?? process.env['CHROME_PATH']
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

if (url === undefined) {
  console.error('usage: node tools/check-grid-batch5.mjs --url <tokenized url> [--port 9226] [--shot out.png]')
  process.exit(2)
}

/**
 * Query that answers thousands of rows on any Doris/MySQL connection without
 * needing a particular table (`numbers()` is ClickHouse, not Doris).
 */
const SQL = 'SELECT TABLE_NAME, ORDINAL_POSITION, CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns LIMIT 3000'

async function startChrome() {
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-proxy-server',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env['TEMP'] ?? '/tmp'}/dsh-data-ide-grid5-${Date.now()}`,
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

// Biggest page the pager offers, so the window has something to window.
await session.evaluate(`(() => {
  const select = document.querySelector('[aria-label="页大小"]')
  if (select === null) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(select, '5000')
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
await sleep(400)

await session.evaluate(`(() => {
  const textarea = document.querySelector('[data-sql-workbench] textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(textarea, ${JSON.stringify(SQL)})
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(300)

await session.evaluate(`document.querySelector('[aria-label="执行"]')?.click()`)
await sleep(6000)

const afterRun = await session.evaluate(`(() => {
  const grid = document.querySelector('[data-grid-state]')
  const scroller = document.querySelector('[role="grid"]')
  if (scroller === null) {
    return {
      state: grid?.getAttribute('data-grid-state') ?? null,
      missingGrid: true,
      panelText: (document.querySelector('[data-sql-workbench]')?.innerText ?? '').slice(0, 400),
    }
  }
  const rows = [...document.querySelectorAll('tbody tr')]
  const dataRows = rows.filter(row => row.getAttribute('data-window-pad') === null)
  return {
    state: grid?.getAttribute('data-grid-state') ?? null,
    count: document.querySelector('[data-grid-count]')?.textContent ?? null,
    domRows: dataRows.length,
    padTop: document.querySelector('[data-window-pad="top"]') ? 1 : 0,
    padBottom: document.querySelector('[data-window-pad="bottom"]') ? 1 : 0,
    scrollHeight: scroller?.scrollHeight ?? 0,
    clientHeight: scroller?.clientHeight ?? 0,
    status: document.querySelector('[data-grid-status]')?.textContent ?? null,
    range: document.querySelector('[data-grid-range]')?.textContent ?? null,
    stat: document.querySelector('[data-grid-stat]')?.textContent ?? null,
    charset: document.querySelector('[data-grid-charset]')?.textContent ?? null,
  }
})()`)

if (afterRun.missingGrid === true) {
  console.log(JSON.stringify({ sql: SQL, afterRun, reason: '结果网格没有出现' }, null, 2))
  session.socket.close()
  browser.kill()
  process.exit(1)
}

// Scroll to the bottom and see the window move rather than the row count grow.
const scrolled = await session.evaluate(`(async () => {
  const scroller = document.querySelector('[role="grid"]')
  scroller.scrollTop = scroller.scrollHeight
  scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 400))
  const dataRows = [...document.querySelectorAll('tbody tr')].filter(row => row.getAttribute('data-window-pad') === null)
  const first = dataRows[0]?.querySelector('td')?.textContent ?? null
  const last = dataRows[dataRows.length - 1]?.querySelector('td')?.textContent ?? null
  return { domRows: dataRows.length, first, last, padTop: document.querySelector('[data-window-pad="top"]') ? 1 : 0 }
})()`)

// Select a block of cells: drag from row 1 to row 10 on the first column.
const selected = await session.evaluate(`(async () => {
  const scroller = document.querySelector('[role="grid"]')
  scroller.scrollTop = 0
  scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 300))
  const cells = [...document.querySelectorAll('tbody tr:not([data-window-pad]) td')]
  // Column 2 (ORDINAL_POSITION) is the numeric one: an aggregate needs numbers.
  cells[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  // React state has to land before the drag continues, or the hover handler
  // still sees "no selection".
  await new Promise(resolve => setTimeout(resolve, 250))
  const tenth = cells[10]
  tenth.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, buttons: 1 }))
  await new Promise(resolve => setTimeout(resolve, 300))
  return {
    range: document.querySelector('[data-grid-range]')?.textContent ?? null,
    stat: document.querySelector('[data-grid-stat]')?.textContent ?? null,
    selected: document.querySelectorAll('td[data-selected]').length,
  }
})()`)

// Switch the aggregator to AVG and check the figure changes.
const averaged = await session.evaluate(`(async () => {
  const select = document.querySelector('[aria-label="聚合函数"]')
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(select, 'AVG')
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 300))
  return document.querySelector('[data-grid-stat]')?.textContent ?? null
})()`)

// Value viewer on the selected cell.
const viewer = await session.evaluate(`(async () => {
  const cell = document.querySelector('tbody tr:not([data-window-pad]) td')
  cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 400))
  const dialog = document.querySelector('[data-value-viewer]')
  return {
    opened: dialog !== null,
    title: dialog?.querySelector('[class*=valueViewerTitle]')?.textContent ?? null,
    text: (dialog?.querySelector('[data-value-text]')?.textContent ?? '').slice(0, 40),
  }
})()`)

if (shot !== undefined) {
  const capture = await session.send('Page.captureScreenshot', { format: 'png' })
  if (capture.result?.data !== undefined) writeFileSync(shot, Buffer.from(capture.result.data, 'base64'))
}

const facts = {
  sql: SQL,
  afterRun,
  scrolled,
  selected,
  averaged,
  viewer,
  errors: session.events
    .filter(event => event.method === 'Runtime.exceptionThrown')
    .map(event => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text)
    .filter(line => /dsh-data-ide/i.test(String(line))),
}
console.log(JSON.stringify(facts, null, 2))

session.socket.close()
browser.kill()

const windowed = afterRun.domRows > 10 && afterRun.domRows < 400 && afterRun.padBottom === 1
const moved = scrolled.padTop === 1 && scrolled.first !== '0'
// A numeric selection must produce a real figure, not a dash.
const aggregated = /SUM\(.+\) = [\d,]/.test(selected.stat ?? '') && selected.selected >= 3
const switched = (averaged ?? '').includes('AVG')
const viewed = viewer.opened && viewer.text !== ''
process.exit(windowed && moved && aggregated && switched && viewed ? 0 : 1)

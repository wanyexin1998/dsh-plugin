/**
 * Diagnostic: is the chat tab type offered by the shell's own "new tab" entry,
 * and does picking it there mount the tab?
 *
 * Usage: node tools/diag-tab-guide.mjs <guiBaseUrl> <authToken>
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const EDGE = process.env.DSH_EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const [guiBase, authToken] = process.argv.slice(2)
const edge = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dsh-chat-guide-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1400,900', 'about:blank',
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
const problems = []
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
  if (message.method === 'Runtime.exceptionThrown') {
    problems.push(String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text).slice(0, 240))
  }
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session)
  return result.exceptionDetails === undefined ? result.result.value : { __error: result.exceptionDetails.text }
}
const click = async (point) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 }, session)
  }
}

const target = await send('Target.createTarget', { url: 'about:blank' })
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
const session = attached.sessionId
await send('Page.enable', {}, session)
await send('Runtime.enable', {}, session)
await send('Page.navigate', { url: `${guiBase}/?token=${authToken}` }, session)
await new Promise(resolve => setTimeout(resolve, 14_000))

// A session must be open before the sidebar can hold tabs.
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('新会话')); if (b) b.click(); return true })()`)
await new Promise(resolve => setTimeout(resolve, 6000))

// Every control the right column offers, so the shell's own entry can be found by
// its label rather than by a guessed class name.
const controls = await evaluate(`(() => {
  return [...document.querySelectorAll('button, [role="button"]')].map(node => {
    const r = node.getBoundingClientRect();
    return {
      label: (node.getAttribute('aria-label') || node.getAttribute('title') || (node.textContent || '').trim()).slice(0, 30),
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      visible: r.width > 0 && r.height > 0,
      rightHalf: r.left > innerWidth * 0.6,
    };
  }).filter(entry => entry.visible);
})()`)
console.log('visible controls on the right half:')
for (const entry of controls.filter(c => c.rightHalf)) console.log('  ' + JSON.stringify(entry))

const addTab = controls.find(entry => /新标签|新建标签|添加标签|new tab|\+/.test(entry.label) && entry.rightHalf)
console.log('\n"new tab" candidate: ' + (addTab === undefined ? 'not found by label' : JSON.stringify(addTab)))

if (addTab !== undefined) {
  await click(addTab)
  await new Promise(resolve => setTimeout(resolve, 1500))
  const guide = await evaluate(`(() => {
    const items = [...document.querySelectorAll('button, [role="button"], li')].map(node => ({
      label: (node.getAttribute('aria-label') || (node.textContent || '').trim()).slice(0, 40),
      y: Math.round(node.getBoundingClientRect().top),
      x: Math.round(node.getBoundingClientRect().left + node.getBoundingClientRect().width / 2),
      visible: node.getBoundingClientRect().width > 0,
    })).filter(entry => entry.visible && entry.label !== '');
    return items.filter(entry => /Chat|聊天|浏览器|Browser|计划|Plan/i.test(entry.label));
  })()`)
  console.log('guide entries mentioning our type or a sibling builtin:')
  for (const entry of guide.slice(0, 12)) console.log('  ' + JSON.stringify(entry))
  const mine = guide.find(entry => /DeepSeek Chat/.test(entry.label))
  if (mine !== undefined) {
    await click({ x: mine.x, y: mine.y })
    await new Promise(resolve => setTimeout(resolve, 5000))
    const after = await evaluate(`(() => ({
      tabs: document.querySelectorAll('[data-sidebar-right-tab]').length,
      bridgeTab: document.querySelectorAll('[data-bridge-tab]').length,
      frameSrc: (document.querySelector('[data-bridge-tab] iframe') || {}).src || null,
      rightbarWidth: (() => { const c = [...document.querySelectorAll('#root div')].find(n => /rightbarCol$/.test(String(n.className))); return c === null ? null : Math.round(c.getBoundingClientRect().width) })(),
    }))()`)
    console.log('after picking our entry:', JSON.stringify(after))
  } else {
    console.log('our type is NOT in the guide')
  }
}
console.log('problems: ' + (problems.length === 0 ? 'none' : JSON.stringify(problems.slice(0, 3))))
socket.close()
edge.kill()
process.exit(0)

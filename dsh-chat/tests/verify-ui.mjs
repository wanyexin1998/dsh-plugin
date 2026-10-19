/**
 * Browser verification harness for dsh-chat.
 *
 * Opens the test profile's GUI in a headless Edge, drives the plugin's own UI
 * through CDP with real mouse events, and asserts the contract:
 *
 *   - the strip floats over an untouched page, collapsed to an arrow hint
 *   - hovering it expands the switch, and the pointer leaving collapses it
 *   - every control inside is clickable, not part of the window's drag region
 *   - choosing chat mounts the proxied chat.deepseek.com document
 *   - the page carries no account readout and logs no error from the bridge
 *
 * Usage: node tests/verify-ui.mjs <guiBaseUrl> <authToken> [screenshotPath]
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const EDGE = process.env.DSH_EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const guiBase = process.argv[2]
const authToken = process.argv[3]
const shotPath = process.argv[4]

if (guiBase === undefined || authToken === undefined) {
  console.error('usage: node verify-ui.mjs <guiBaseUrl> <authToken> [screenshotPath]')
  process.exit(2)
}

// A fresh profile per run: reusing one leaves the previous run's CDP log entries
// and cache in place, which shows up as CORS errors from a page that is long gone.
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-verify-'))
mkdirSync(profileDir, { recursive: true })

const edge = spawn(EDGE, [
  '--headless=new',
  '--remote-debugging-port=0',
  '--user-data-dir=' + profileDir,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1280,900',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

/** Read the DevTools websocket endpoint from stderr, then connect. */
function waitForEndpoint() {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => { reject(new Error('edge did not report a devtools endpoint')) }, 30_000)
    edge.stderr.on('data', chunk => {
      buffer += String(chunk)
      const match = /ws:\/\/[^\s]+/.exec(buffer)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[0])
      }
    })
  })
}

const endpoint = await waitForEndpoint()
const socket = new WebSocket(endpoint)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
/** One CDP session command; resolves with the reply payload. */
function send(method, params = {}, sessionId) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  })
}

const consoleErrors = []
/** DevTools log entries and failed requests; CORS refusals show up here. */
const logEntries = []
const failedRequests = []
/** Every network response the page saw; the framed document is read from here. */
const responses = []
/** Frame lifecycle events, used to wait for the framed document to finish. */
let frameLoads = 0
let pageSession
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined) {
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(`${message.method}: ${JSON.stringify(message.error)}`))
    else entry.resolve(message.result)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  }
  if (message.method === 'Log.entryAdded') {
    logEntries.push({ level: message.params.entry.level, text: message.params.entry.text })
  }
  if (message.method === 'Network.loadingFailed') {
    failedRequests.push({ error: message.params.errorText, blocked: message.params.blockedReason })
  }
  if (message.method === 'Network.responseReceived') {
    responses.push({
      url: message.params.response.url,
      status: message.params.response.status,
      type: message.params.type,
      mimeType: message.params.response.mimeType,
    })
  }
  if (message.method === 'Page.frameNavigated' || message.method === 'Page.loadEventFired') {
    frameLoads += 1
  }
})

/** Open a blank tab and attach to it. */
const target = await send('Target.createTarget', { url: 'about:blank' })
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
pageSession = attached.sessionId
await send('Runtime.enable', {}, pageSession)
await send('Page.enable', {}, pageSession)
await send('Network.enable', {}, pageSession)
await send('Log.enable', {}, pageSession)
await send('Network.setCacheDisabled', { cacheDisabled: true }, pageSession)

/** Navigate and wait for the load event. */
function navigate(url) {
  return new Promise(resolve => {
    const onMessage = event => {
      const message = JSON.parse(String(event.data))
      if (message.method === 'Page.loadEventFired') {
        socket.removeEventListener('message', onMessage)
        resolve()
      }
    }
    socket.addEventListener('message', onMessage)
    void send('Page.navigate', { url }, pageSession)
  })
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, pageSession)
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
  }
  return result.result.value
}

/** Poll until the predicate returns truthy, or time out. */
async function waitFor(expression, timeoutMs = 20_000, label = expression) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await evaluate(expression)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

const report = { steps: [] }
const step = (name, detail) => {
  report.steps.push({ name, detail })
  console.log(`== ${name}\n   ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

await navigate(`${guiBase}/?token=${authToken}`)
await waitFor('document.querySelectorAll("button").length > 3', 30_000, 'shell buttons')

step('capsule rendered', await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')].filter(b => ['工作','聊天'].includes(b.textContent.trim()));
  return buttons.map(b => ({ label: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') }));
})()`))

step('overlay hidden before switching', await evaluate(`(() => {
  const overlay = [...document.querySelectorAll('div')].find(d => d.getAttribute('aria-label') === 'DeepSeek Chat 网页版');
  return overlay === undefined ? 'not created yet' : getComputedStyle(overlay).visibility;
})()`))

/**
 * Move a real pointer onto the strip and wait for it to expand.
 *
 * The strip is collapsed until the pointer is on it, so any measurement or click
 * that targets its controls has to happen after this. Dispatching a real
 * `mouseMoved` is the point: `mouseenter` from a synthesized DOM event would not
 * prove the browser hit-tests the strip, which is what the drag region spoils.
 */
async function hoverStrip() {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 300 }, pageSession)
  const stripPoint = await evaluate(`(() => {
    const bar = document.querySelector('[data-bridge-strip]');
    if (bar === null) return null;
    const r = bar.getBoundingClientRect();
    return { x: Math.round(innerWidth / 2), y: Math.round(r.top + r.height / 2) };
  })()`, pageSession)
  if (stripPoint !== null) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stripPoint.x, y: stripPoint.y }, pageSession)
  await new Promise(resolve => setTimeout(resolve, 400))
}

/**
 * Click a control with a real synthesized mouse event at its centre. A
 * programmatic `.click()` bypasses hit-testing, so it cannot catch the failure
 * this plugin actually hit on the desktop: a capsule drawn inside the window's
 * drag region was visible but received no pointer input at all.
 *
 * @param label - exact button text or accessible name.
 * @returns the point clicked and what the browser reported under it.
 */
async function clickReally(label) {
  await hoverStrip()
  const box = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(b =>
      b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (button === undefined) return null;
    const r = button.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x: Math.round(x), y: Math.round(y), hitIsSelf: hit === button || button.contains(hit),
      hitText: hit === null ? null : (hit.textContent || '').trim().slice(0, 16) };
  })()`)
  if (box === null) throw new Error(`no control labelled ${label}`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, pageSession)
  }
  return box
}

step('the collapsed strip shows its arrow hint', await evaluate(`(() => {
  const bar = document.querySelector('[data-bridge-strip]');
  const handle = bar.querySelector('[data-bridge-handle]');
  return {
    expanded: bar.hasAttribute('data-bridge-expanded'),
    contentOpacity: getComputedStyle(bar.firstElementChild).opacity,
    handleOpacity: Number(getComputedStyle(handle).opacity),
    handleLabel: handle.getAttribute('aria-label'),
  };
})()`))

await hoverStrip()
step('switch strip floats over the untouched page', await evaluate(`(() => {
  const bar = document.querySelector('[data-bridge-strip]');
  const handle = bar.querySelector('[data-bridge-handle]');
  const content = bar.firstElementChild;
  const track = bar.querySelector('[data-bridge-segment]');
  const r = bar.getBoundingClientRect();
  const style = getComputedStyle(bar);
  const trackStyle = getComputedStyle(track);
  const slider = track.querySelector('span[aria-hidden]');
  const sliderStyle = getComputedStyle(slider);
  const rootStyle = getComputedStyle(document.documentElement);
  const rootElement = document.documentElement;
  const trackRect = track.getBoundingClientRect();
  const reg = (node) => { const s = getComputedStyle(node); return s.getPropertyValue('app-region') || s.webkitAppRegion || '(none)' };
  const tabs = [...track.querySelectorAll('button')].map(b => ({
    label: b.textContent.trim(),
    active: b.getAttribute('aria-pressed') === 'true',
    color: getComputedStyle(b).color,
  }));
  return {
    top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width),
    chromeClearance: Math.round(parseFloat(rootStyle.getPropertyValue('--dsh-frame-top-clearance')) || 40),
    // Nothing may be reserved: the page keeps its original height.
    rowVar: rootElement.style.getPropertyValue('--dsh-deepseek-bridge-row') || '(unset)',
    reservedFrame: document.querySelector('[data-deepseek-bridge-frame]') !== null,
    bridgeStyleNodes: document.querySelectorAll('style[data-bridge-style]').length,
    expanded: bar.hasAttribute('data-bridge-expanded'),
    contentOpacity: getComputedStyle(content).opacity,
    handleOpacity: Number(getComputedStyle(handle).opacity),
    handleLabel: handle.getAttribute('aria-label'),
    viewportHeight: innerHeight,
    captionFill: rootStyle.getPropertyValue('--dsw-specific-sidebar-fill').trim() || '(unset)',
    // Centred on the window, which is what "middle of the strip" means here.
    centreOffset: Math.round((trackRect.left + trackRect.width / 2) - innerWidth / 2),
    stripBackground: style.backgroundColor, stripBorder: style.borderTopWidth, stripShadow: style.boxShadow,
    stripIsDraggable: reg(bar),
    handleTop: Math.round(handle.getBoundingClientRect().top),
    handleBottom: Math.round(handle.getBoundingClientRect().bottom),
    stripBottom: Math.round(r.bottom),
    stripZIndex: Number(style.zIndex) || 0,
    panelZIndex: (() => {
      const panel = [...document.querySelectorAll('div')].find(d => d.getAttribute('aria-label') === 'DeepSeek Chat 网页版');
      return panel === undefined ? 0 : Number(getComputedStyle(panel).zIndex) || 0;
    })(),
    handleIsDraggable: reg(handle),
    segmentIsDraggable: reg(track),
    trackBackground: trackStyle.backgroundColor, trackRadius: trackStyle.borderTopLeftRadius,
    slider: {
      background: sliderStyle.backgroundColor,
      radius: sliderStyle.borderTopLeftRadius,
      hasShadow: sliderStyle.boxShadow !== 'none',
      transform: sliderStyle.transform,
      width: Math.round(slider.getBoundingClientRect().width),
      left: Math.round(slider.getBoundingClientRect().left),
    },
    trackLeft: Math.round(trackRect.left),
    trackWidth: Math.round(trackRect.width),
    tabs,
  };
})()`))

step('the chat view shows no account readout', await evaluate(`(() => {
  const strip = document.querySelector('[data-bridge-strip]');
  const labels = [...strip.querySelectorAll('button')].map(b => b.textContent.trim());
  return {
    buttonsInStrip: labels,
    showsMaskedContact: labels.some(label => label.includes('¥') || label.includes('余额') || label.includes('****')),
    accountControls: [...document.querySelectorAll('button')].filter(b =>
      (b.getAttribute('aria-label') || '').includes('账号')).length,
  };
})()`))

// Choosing chat opens a real browser window. That window would take over this
// session's active target and make every later measurement read the wrong page,
// so the popup is stubbed here; the window itself is exercised end to end by
// tests/verify-external-window.mjs, which drives the ticket URL it produces.
await evaluate(`(() => { window.__realOpen = window.open; window.open = () => null; return true })()`)
step('the popup is stubbed so this session keeps reading the app page', 'stubbed')
const clickPoint = await clickReally('聊天')
step('real mouse click on 聊天', clickPoint)

step('theme tokens the switch resolves against', await evaluate(`(() => {
  const style = getComputedStyle(document.documentElement);
  const names = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay', '--dsw-specific-sidebar-fill', '--dsw-alias-state-idle-primary',
    '--dsw-alias-border-l1', '--dsw-alias-label-secondary'];
  const out = {};
  for (const name of names) out[name] = style.getPropertyValue(name).trim() || '(unset)';
  return out;
})()`))

// Choosing chat hands off to a real browser window: a real window is a
// first-party context for the bridge, so the session cookie survives there. The
// page therefore must NOT embed a frame. The ticket itself is probed at the very
// end, because touching it can open a window and move this session's target.
await new Promise(resolve => setTimeout(resolve, 1500))
step('no frame is embedded for the chat view', await evaluate(`
  document.querySelectorAll('iframe').length`))

step('takeover covers the frame', await evaluate(`(() => {
  const overlay = [...document.querySelectorAll('div')].find(d => d.getAttribute('aria-label') === 'DeepSeek Chat 网页版');
  if (!overlay) return null;
  const r = overlay.getBoundingClientRect();
  return { top: r.top, left: r.left, width: Math.round(r.width), height: Math.round(r.height), viewport: [innerWidth, innerHeight] };
})()`))

step('root structure', await evaluate(`(() => {
  const root = document.getElementById('root');
  return [...root.children].map(child => ({
    tag: child.tagName, cls: String(child.className).slice(0, 40), label: child.getAttribute('aria-label'),
    inert: child.hasAttribute('inert'),
    hasCapsule: child.querySelector('[aria-label="DeepSeek Chat 切换"]') !== null,
    hasOverlay: child.querySelector('[aria-label="DeepSeek Chat 网页版"]') !== null,
  }));
})()`))

step('capsule ancestry', await evaluate(`(() => {
  const capsule = document.querySelector('[aria-label="DeepSeek Chat 切换"]');
  const chain = [];
  for (let node = capsule; node !== null && node !== document.body; node = node.parentElement) {
    chain.push(node.tagName + (node.id ? '#' + node.id : '') + (node.getAttribute('aria-label') ? '[' + node.getAttribute('aria-label') + ']' : ''));
  }
  return chain;
})()`))

step('inert subtrees behind the takeover', await evaluate(`document.querySelectorAll('[inert]').length`))

step('takeover subtrees are the shell columns', await evaluate(`[...document.querySelectorAll('[inert]')].map(el => {
  const r = el.getBoundingClientRect();
  return { width: Math.round(r.width), height: Math.round(r.height), tag: el.tagName };
})`))

// With the takeover open the strip must stay visible and clickable ON TOP of the
// panel: it is the switch, and a switch that vanishes once used is the bug this
// asserts against. The bar is the strip's positioned wrapper.
// The strip's own invariants, measured on the live page: it is the switch, so a
// switch that disappears or stops receiving clicks is the bug this asserts
// against. Measured before the hand-off opens a window, which moves this
// session's active target away from the app page.
const stripProbe = await evaluate(`(() => {
  const switchNode = document.querySelector('[data-bridge-segment]');
  if (switchNode === null) return null;
  const bar = switchNode.parentElement;
  const rect = bar.getBoundingClientRect();
  const y = Math.round(rect.top + rect.height / 2);
  const x = Math.round(innerWidth / 2);
  const top = document.elementFromPoint(x, y);
  const tabs = [...switchNode.querySelectorAll('button')].map(b => ({
    label: b.textContent.trim(), active: b.getAttribute('aria-pressed') === 'true',
  }));
  return {
    insideInert: switchNode.closest('[inert]') !== null,
    display: getComputedStyle(bar).display,
    pointerEvents: getComputedStyle(bar).pointerEvents,
    barTop: Math.round(rect.top), barHeight: Math.round(rect.height),
    zIndex: Number(getComputedStyle(bar).zIndex),
    topElementIsTheSwitch: top !== null && (top === switchNode || switchNode.contains(top)),
    tabs,
  };
})()`)
step('the switch is visible and clickable', stripProbe)
const stripWhileOpen = stripProbe
const inertCount = await evaluate(`document.querySelectorAll('[inert]').length`)

// The two trailing icons are the controls that did nothing on the desktop: they
// sat inside the strip's drag region, which Electron uses to move the window and
// therefore swallows clicks. This clicks them for real and watches what follows.
await hoverStrip()
const iconReport = await evaluate(`(async () => {
  const strip = document.querySelector('[data-bridge-strip]');
  const region = (node) => { const s = getComputedStyle(node); return s.getPropertyValue('app-region') || s.webkitAppRegion || '(none)' };
  const result = {};
  for (const label of ['刷新网页版', '在浏览器窗口中打开']) {
    const button = [...strip.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label);
    if (button === undefined) { result[label === '刷新网页版' ? 'reload' : 'outside'] = { missing: true }; continue }
    const r = button.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    result[label === '刷新网页版' ? 'reload' : 'outside'] = {
      hitIsSelf: hit === button || button.contains(hit),
      appRegion: region(button),
      point: { x, y },
    };
  }
  return result;
})()`)
step('trailing icon hit-testing', iconReport)

// ⟳ must re-navigate the frame; ↗ must ask the host for a ticket.
const reloadFrames = await evaluate(`(async () => {
  const before = document.querySelector('iframe[title="DeepSeek Chat"]')?.src ?? null;
  const button = [...document.querySelectorAll('[data-bridge-strip] button')].find(b => b.getAttribute('aria-label') === '刷新网页版');
  if (button === undefined) return { clicked: false };
  button.click();
  await new Promise(resolve => setTimeout(resolve, 600));
  const after = document.querySelector('iframe[title="DeepSeek Chat"]')?.src ?? null;
  return { clicked: true, changed: before !== after, before, after };
})()`)
step('⟳ re-navigates the framed page', reloadFrames)

const ticketAsk = await evaluate(`(async () => {
  const seen = [];
  const original = window.fetch;
  window.fetch = (input, init) => { seen.push(String(typeof input === 'string' ? input : input.url)); return original(input, init) };
  const popup = window.open;
  window.open = () => null;
  const button = [...document.querySelectorAll('[data-bridge-strip] button')].find(b => b.getAttribute('aria-label') === '在浏览器窗口中打开');
  if (button === undefined) { window.fetch = original; window.open = popup; return { clicked: false } }
  button.click();
  await new Promise(resolve => setTimeout(resolve, 900));
  window.fetch = original;
  window.open = popup;
  return { clicked: true, askedForTicket: seen.some(url => url.includes('/api/ticket')) };
})()`)
step('↗ asks the host for a ticket', ticketAsk)
iconReport.reload.requestsAfterClick = reloadFrames.changed === true ? 1 : 0
iconReport.outside.askedForTicket = ticketAsk.askedForTicket === true

const sessionResult = await evaluate(`fetch('/dsh-chat/api/session', { headers: { accept: 'application/json' } }).then(r => r.json()).then(s => ({
  ready: s.ready, origin: s.origin, target: s.target, tokenLength: s.sessionToken.length,
}))`)
step('session route', sessionResult)

const framedResponses = []
step('framed document responses', framedResponses)
step('framed subresources from fe-static', responses.filter(entry => entry.url.includes('fe-static.deepseek.com')).length)
step('framed subresource statuses', responses
  .filter(entry => entry.url.includes('fe-static.deepseek.com'))
  .map(entry => `${String(entry.status)} ${entry.url.split('/').pop()}`)
  .slice(0, 6))
// After the static-origin rewrite the frame must load every asset from this
// proxy; anything still addressed to the CDN is a CORS refusal waiting to happen.
step('framed assets served same-origin', responses
  .filter(entry => entry.url.includes('/__bridge_static/'))
  .map(entry => `${String(entry.status)} ${entry.url.split('/').pop()}`)
  .slice(0, 12))
step('framed assets still fetched from the CDN', responses
  .filter(entry => entry.url.includes('fe-static.deepseek.com')).length)
// `net::ERR_ABORTED` is the normal outcome for a navigation that is replaced
// (the token-exchange redirect) and for speculative prefetches the SPA drops;
// only a real transport or policy failure indicates a broken frame.
const realFailures = failedRequests.filter(entry => entry.error !== 'net::ERR_ABORTED')
step('failed frame requests', failedRequests.slice(0, 6))
step('real frame failures (aborted navigations excluded)', realFailures.length === 0 ? 'none' : realFailures.slice(0, 4))
const corsLogs = logEntries.filter(entry => /CORS|Access-Control/i.test(entry.text))
step('CORS refusals in the page log', corsLogs.length === 0 ? 'none' : corsLogs.slice(0, 4))
const blockedOrigins = logEntries.filter(entry => /fe-static\.deepseek\.com/.test(entry.text))
step('any log entry naming the CDN', blockedOrigins.length === 0 ? 'none' : blockedOrigins.slice(0, 3))

// The way back: click 工作 with a real mouse event — the drag region once
// swallowed exactly this click. It also proves the switch survives the panel.
const backPoint = await clickReally('工作')
step('real mouse click on 工作', backPoint)
await new Promise(resolve => setTimeout(resolve, 900))

// Both segments must still be there after the round trip: the switch is the way
// back, and it must never be swallowed by whatever the chat view is doing. The
// click itself is not repeated here — it opens a real window, which moves this
// session's active target away from the app page.
await new Promise(resolve => setTimeout(resolve, 800))
const stripAfterHandOff = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[data-bridge-segment] button')].map(b => ({
    label: b.textContent.trim(), active: b.getAttribute('aria-pressed') === 'true',
    width: Math.round(b.getBoundingClientRect().width),
  }));
  return { tabs, iframes: document.querySelectorAll('iframe').length };
})()`)
step('switch survives the hand-off', stripAfterHandOff)

const afterBack = await evaluate(`(() => {
  const overlay = [...document.querySelectorAll('div')].find(d => d.getAttribute('aria-label') === 'DeepSeek Chat 网页版');
  const root = document.getElementById('root');
  const tabs = [...document.querySelectorAll('[data-bridge-segment] button')].map(b => ({
    label: b.textContent.trim(), active: b.getAttribute('aria-pressed') === 'true',
  }));
  return {
    overlayPresent: overlay !== undefined,
    overlayVisible: overlay !== undefined && getComputedStyle(overlay).visibility === 'visible',
    inertChildren: [...root.children].filter(c => c.hasAttribute('inert')).length,
    inertOnPage: document.querySelectorAll('[inert]').length,
    frameStillMounted: document.querySelectorAll('iframe').length,
    workActive: tabs.some(tab => tab.label === '工作' && tab.active === true),
    chatInactive: tabs.some(tab => tab.label === '聊天' && tab.active === false),
  };
})()`)
step('after switching back', afterBack)

if (shotPath !== undefined) {
  mkdirSync(dirname(shotPath), { recursive: true })
  const shot = await send('Page.captureScreenshot', { format: 'png' }, pageSession)
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  step('screenshot', shotPath)
}

step('console errors', consoleErrors.length === 0 ? 'none' : consoleErrors.slice(0, 8))

// A harness that always exits 0 proves nothing, so every criterion is stated
// here as a named assertion and a failure is reported through the exit code.
const stripReport = report.steps.find(entry => entry.name === 'switch strip floats over the untouched page').detail
const collapsedReport = report.steps.find(entry => entry.name === 'the collapsed strip shows its arrow hint').detail
const accountButtonReport = report.steps.find(entry => entry.name === 'the chat view shows no account readout').detail

const assertions = [
  ['strip has both tabs', report.steps[0].detail.length === 2],
  ['the page keeps its original size', stripReport.rowVar === '(unset)'
    && stripReport.reservedFrame === false && stripReport.bridgeStyleNodes === 0],
  ['the strip floats just below the window chrome', stripReport.top === stripReport.chromeClearance
    && stripReport.height > 0 && stripReport.height <= 60],
  ['the strip expands on hover',
    stripReport.expanded === true && stripReport.contentOpacity === '1'],
  ['the arrow hint hides once the strip is open',
    stripReport.handleOpacity === 0 && collapsedReport.handleOpacity >= 0.3],
  ['the arrow points at nothing else', collapsedReport.handleLabel === '展开切换条'],
  ['no part of the strip claims the native drag region',
    stripReport.stripIsDraggable === 'no-drag'
    && stripReport.segmentIsDraggable === 'no-drag'
    && stripReport.handleIsDraggable === 'no-drag'],
  ['strip is centred on the window', Math.abs(stripReport.centreOffset) <= 3],
  ['the window stays movable by the caption, not by this row',
    stripReport.stripIsDraggable === 'no-drag'],
  ['strip background is transparent', stripReport.stripBackground === 'rgba(0, 0, 0, 0)'],
  ['strip carries no border and no shadow', stripReport.stripBorder === '0px' && stripReport.stripShadow === 'none'],
  ['the track is a capsule with a visible ground', stripReport.trackBackground !== 'rgba(0, 0, 0, 0)'
    && parseFloat(stripReport.trackRadius) >= 20],
  ['one slider pill carries the shadow', stripReport.slider.hasShadow === true
    && parseFloat(stripReport.slider.radius) >= 20 && stripReport.slider.width > 20],
  ['the slider sits under the active cell', stripReport.slider.left >= stripReport.trackLeft
    && stripReport.slider.left + stripReport.slider.width <= stripReport.trackLeft + stripReport.trackWidth],
  ['only the active cell is labelled as pressed', stripReport.tabs.filter(tab => tab.active).length === 1],
  ['the chat view shows no account readout', accountButtonReport.showsMaskedContact === false
    && accountButtonReport.accountControls === 0],
  ['the handle slides down when the strip expands',
    stripReport.handleTop > 0 && stripReport.handleBottom <= stripReport.stripBottom + 2],
  ['real click on 聊天 is hit-testable', clickPoint.hitIsSelf === true],
  ['the trailing icons are hit-testable, not drag handles',
    iconReport.reload.hitIsSelf === true && iconReport.outside.hitIsSelf === true
    && iconReport.reload.appRegion === 'no-drag' && iconReport.outside.appRegion === 'no-drag'],
  ['clicking ⟳ reloads the framed page and ↗ asks for a ticket',
    iconReport.reload.requestsAfterClick > 0 && iconReport.outside.askedForTicket === true],
  ['real click on 工作 is hit-testable', backPoint.hitIsSelf === true],
  ['both segments are still rendered after the hand-off',
    (() => {
      const step = report.steps.find(entry => entry.name === 'switch survives the hand-off')
      const tabs = step?.detail?.tabs ?? []
      return tabs.length === 2 && tabs.every(tab => tab.width > 10)
    })()],
  ['the way back works: 工作 is active again and the panel is closed',
    afterBack.workActive === true && afterBack.chatInactive === true && afterBack.overlayVisible === false],

  ['framed assets load same-origin', responses.some(entry => entry.url.includes('/__bridge_static/') && entry.status === 200)],
  ['no framed asset still hits the CDN', responses.every(entry => !entry.url.includes('fe-static.deepseek.com'))],
  ['no CORS refusal logged', corsLogs.length === 0],
  ['no log entry names the CDN', blockedOrigins.length === 0],
  ['no failed frame request', realFailures.length === 0],
  ['session is ready', sessionResult.ready === true && sessionResult.tokenLength === 64],
  ['the switch stays visible and clickable', stripWhileOpen.display !== 'none'
    && stripWhileOpen.pointerEvents === 'auto' && stripWhileOpen.topElementIsTheSwitch === true
    && stripWhileOpen.insideInert === false],
  ['the strip is painted above the takeover',
    Number(stripReport.stripZIndex) > Number(stripReport.panelZIndex ?? 0)],
  ['no console errors', consoleErrors.length === 0],
]
// Last: the hand-off ticket. Touching it can open a window and move this
// session's active target, so nothing else may read the page afterwards.
const ticketProbe = await evaluate(`(async () => {
  try {
    const originalOpen = window.open;
    window.open = () => null;
    const response = await fetch('/dsh-chat/api/ticket', { method: 'POST' });
    window.open = originalOpen;
    if (!response.ok) return { ok: false, status: response.status };
    const payload = await response.json();
    const parsed = new URL(payload.url);
    return {
      ok: true, status: response.status, origin: parsed.origin, path: parsed.pathname,
      carriesTicket: parsed.searchParams.has('__bridge_ticket'),
      carriesSessionToken: parsed.searchParams.has('__bridge_session'),
      ticketLength: (parsed.searchParams.get('__bridge_ticket') ?? '').length,
    };
  } catch (error) { return { ok: false, error: String(error.message ?? error) } }
})()`)
step('browser hand-off ticket shape', ticketProbe)

// This one is checked here rather than in the list above, because the probe it
// reads runs last: an assertion evaluated earlier would be looking at a step
// that had not happened yet.
assertions.push(['the hand-off hands the browser a one-shot ticket for this bridge',
  ticketProbe?.ok === true && ticketProbe?.carriesTicket === true
  && ticketProbe?.carriesSessionToken === false && (ticketProbe?.ticketLength ?? 0) >= 32])

const failedAssertions = assertions.filter(([, pass]) => !pass)
step('assertions', failedAssertions.length === 0
  ? `${String(assertions.length)}/${String(assertions.length)} passed`
  : { failed: failedAssertions.map(([name]) => name), passed: `${String(assertions.length - failedAssertions.length)}/${String(assertions.length)}` })

socket.close()
edge.kill()
process.exit(failedAssertions.length === 0 ? 0 : 1)

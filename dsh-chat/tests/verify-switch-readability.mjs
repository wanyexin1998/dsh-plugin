/**
 * Verify the switch stays readable in both themes.
 *
 * The switch draws its own surfaces — a translucent track and a white slider —
 * while its labels once came from the shell's theme tokens, which turn
 * near-white in dark mode and vanished on the white slider. This measures the
 * real computed colours and the contrast ratio between each label and the
 * surface behind it, once as the page is and once with a dark preference.
 *
 * Usage: node tests/verify-switch-readability.mjs <guiBase> <authToken>
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const EDGE = process.env.DSH_EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const [guiBase, authToken] = process.argv.slice(2)

const edge = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'dsh-read-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,860', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
const endpoint = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error('no devtools')), 30_000)
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
const send = (method, params = {}, sessionId) => new Promise(resolve => {
  const id = nextId++
  pending.set(id, { resolve })
  socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
})
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.id === undefined) return
  const entry = pending.get(message.id)
  if (entry !== undefined) { pending.delete(message.id); entry.resolve(message.result) }
})
const evaluate = async (expression, sessionId) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (result.exceptionDetails !== undefined) return { __error: result.exceptionDetails.text }
  return result.result.value
}

const target = await send('Target.createTarget', { url: 'about:blank' })
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
const session = attached.sessionId
await send('Page.enable', {}, session)
await send('Page.navigate', { url: `${guiBase}/?token=${authToken}` }, session)
await new Promise(resolve => setTimeout(resolve, 14_000))

/** Hover with a real pointer: the strip only exists visually while hovered. */
async function hover() {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 400 }, session)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 625, y: 20 }, session)
  await new Promise(resolve => setTimeout(resolve, 400))
}

const probe = `(() => {
  // Colours are composited before the ratio is taken: the track is translucent,
  // and treating it as opaque black reports a contrast nobody ever sees.
  const parse = (value) => {
    const numbers = String(value).match(/[\\d.]+/g);
    if (numbers === null) return null;
    const channels = numbers.slice(0, 3).map(Number);
    const rgb = channels.map(channel => (channel <= 1.001 ? channel * 255 : channel));
    const alpha = numbers.length > 3 ? Number(numbers[3]) : 1;
    return { rgb, alpha };
  };
  const over = (front, back) => {
    const a = parse(front), b = parse(back);
    if (a === null || b === null) return null;
    if (a.alpha >= 1) return a.rgb;
    return a.rgb.map((channel, i) => channel * a.alpha + b.rgb[i] * (1 - a.alpha));
  };
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map(channel => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const pageBackground = getComputedStyle(document.body).backgroundColor;
  const flattened = (layer) => over(layer, pageBackground === 'rgba(0, 0, 0, 0)' ? 'rgb(255, 255, 255)' : pageBackground);
  const ratio = (foreground, background) => {
    const fg = parse(foreground);
    const bg = flattened(background);
    if (fg === null || bg === null) return null;
    const dot = fg.alpha >= 1 ? fg.rgb : fg.rgb.map((channel, i) => channel * fg.alpha + bg[i] * (1 - fg.alpha));
    const la = luminance(dot), lb = luminance(bg);
    return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
  };
  const track = document.querySelector('[data-bridge-segment]');
  const slider = track.querySelector('span[aria-hidden]');
  const handle = document.querySelector('[data-bridge-handle]');
  const cells = [...track.querySelectorAll('button')].map(button => {
    const style = getComputedStyle(button);
    const active = button.getAttribute('aria-pressed') === 'true';
    const behind = active ? getComputedStyle(slider).backgroundColor : getComputedStyle(track).backgroundColor;
    return {
      label: button.textContent.trim(),
      active,
      color: style.color,
      behind,
      contrast: ratio(style.color, behind),
    };
  });
  return {
    theme: document.documentElement.getAttribute('data-theme') ?? '(none)',
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    cells,
    handle: { color: getComputedStyle(handle).color, contrast: ratio(getComputedStyle(handle).color, 'rgb(255,255,255)') },
    trackBackground: getComputedStyle(track).backgroundColor,
    sliderBackground: getComputedStyle(slider).backgroundColor,
  };
})()`

const failures = []
const check = (label, pass, detail) => {
  console.log((pass ? '  ok  ' : '  FAIL ') + label + (detail === undefined ? '' : '  ' + JSON.stringify(detail)))
  if (!pass) failures.push(label)
}
const judge = (tag, report) => {
  console.log('--- ' + tag + ' ---')
  check(tag + ': both labels are present', report.cells.length === 2, report.cells.map(cell => cell.label))
  for (const cell of report.cells) {
    check(`${tag}: "${cell.label}" reads at ${String(cell.contrast)}:1`, (cell.contrast ?? 0) >= 4.5,
      { color: cell.color, behind: cell.behind })
  }
  check(tag + ': the handle is visible', (report.handle.contrast ?? 0) >= 3, report.handle)
  check(tag + ': the slider stays white', report.sliderBackground === 'rgb(255, 255, 255)', report.sliderBackground)
}

await hover()
judge('as loaded', await evaluate(probe, session))

await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, session)
await new Promise(resolve => setTimeout(resolve, 700))
await hover()
judge('prefers dark', await evaluate(probe, session))

await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, session)
await send('Runtime.evaluate', { expression: `document.documentElement.setAttribute('data-theme', 'dark')`, returnByValue: true }, session)
await new Promise(resolve => setTimeout(resolve, 700))
await hover()
judge('data-theme=dark', await evaluate(probe, session))

console.log('')
console.log(failures.length === 0 ? 'readability holds in every theme' : 'failed: ' + failures.join('; '))
socket.close()
edge.kill()
process.exit(failures.length === 0 ? 0 : 1)

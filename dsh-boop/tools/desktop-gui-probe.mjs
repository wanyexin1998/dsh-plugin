#!/usr/bin/env node
/**
 * Desktop GUI probe. Uses a private DSH_HOME and a private Electron user-data
 * directory. It refuses to start if either path is the user's ~/.dsh.
 *
 * The desktop profile is a junction to an already-built isolated web profile
 * that contains dsh-boop, so this script does not run pnpm against ~/.dsh.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'playwright-core'

const ROOT = path.resolve(import.meta.dirname, '..')
const EXE = 'E:/deepseek-harness/DeepSeek Harness.exe'
const SOURCE = path.join(
  ROOT,
  '.work/test-runs/web-e2e-control-1793084561604/dsh-home/profiles/boop-web-e2e-control',
)
const RUN = path.join(ROOT, '.work/test-runs/desktop-gui-' + Date.now())
const HOME = path.join(RUN, 'dsh-home')
const USER_DATA = path.join(RUN, 'user-data')
const OUT = path.join(ROOT, 'docs/development/evidence/desktop-gui')
const PORT = 9333
const userDsh = path.join(process.env.USERPROFILE || '', '.dsh')

function assertPrivate(dir) {
  const resolved = path.resolve(dir)
  if (userDsh && resolved.toLowerCase().startsWith(path.resolve(userDsh).toLowerCase())) {
    throw new Error(`refusing to use the user DSH home: ${resolved}`)
  }
}

function mtime(target) {
  try {
    return fs.statSync(target).mtimeMs
  } catch {
    return null
  }
}

function ledgerFacts(home) {
  const file = path.join(home, 'boop', 'boop.sqlite')
  if (!fs.existsSync(file)) return { file, present: false }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const meta = db.prepare('select key, value from meta').all()
    const audits = db.prepare("select kind, reason from audit_event where kind = 'boot/reconciled'").all()
    return { file, present: true, meta, audits }
  } finally {
    db.close()
  }
}

async function boopLabels(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[aria-label], button, a')]
    const labels = nodes
      .map((node) => node.getAttribute('aria-label') || node.textContent || '')
      .map((value) => value.replace(/\s+/g, ' ').trim())
      .filter((value) => /BOOP|波波|任务板/u.test(value))
    return { count: labels.length, labels: labels.slice(0, 12) }
  })
}

async function surfaceFacts(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-boop-panel]')
    const style = panel ? getComputedStyle(panel) : null
    const text = document.body?.innerText || ''
    return {
      dark: document.body?.hasAttribute('data-ds-dark-theme') === true,
      panel: Boolean(panel),
      background: style ? style.backgroundColor : null,
      sheets: [...document.querySelectorAll('style')].filter((node) => (node.textContent || '').includes('[data-boop-')).length,
      newChat: text.includes('新会话'),
      boopText: /BOOP|波波/u.test(text),
    }
  })
}

assertPrivate(HOME)
assertPrivate(USER_DATA)
if (!fs.existsSync(SOURCE)) throw new Error(`missing source profile ${SOURCE}`)
if (!fs.existsSync(EXE)) throw new Error(`missing desktop executable ${EXE}`)

fs.mkdirSync(path.join(HOME, 'profiles'), { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })
fs.mkdirSync(OUT, { recursive: true })
const link = path.join(HOME, 'profiles', 'desktop')
if (!fs.existsSync(link)) fs.symlinkSync(SOURCE, link, 'junction')

const before = mtime(userDsh)
const env = { ...process.env, DSH_HOME: HOME }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(
  EXE,
  [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`],
  {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  },
)
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})
child.stdout.on('data', (chunk) => {
  stderr += chunk.toString()
})

const started = Date.now()
let browser
try {
  let version = null
  for (let i = 0; i < 40; i += 1) {
    if (child.exitCode !== null) break
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) {
        version = await response.json()
        break
      }
    } catch {
      /* port not open yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!version) {
    throw new Error(`desktop debugging port did not open\n${stderr.slice(-2000)}`)
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const page = browser.contexts()[0]?.pages()[0] ?? (await browser.contexts()[0].waitForEvent('page'))
  const consoleNotes = []
  page.on('console', (message) => {
    const line = `${message.type()}: ${message.text()}`.slice(0, 300)
    if (/boop|plugin|error|fail/i.test(line)) consoleNotes.push(line)
  })
  page.on('pageerror', (error) => consoleNotes.push(`pageerror: ${String(error).slice(0, 300)}`))
  let text = ''
  let boop = { count: 0, labels: [] }
  for (let i = 0; i < 40; i += 1) {
    text = await page.locator('body').innerText().catch(() => '')
    boop = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('[aria-label], button, a')]
      const labels = nodes
        .map((node) => node.getAttribute('aria-label') || node.textContent || '')
        .map((value) => value.replace(/\s+/g, ' ').trim())
        .filter((value) => /BOOP|波波|任务板/u.test(value))
      return { count: labels.length, labels: labels.slice(0, 12) }
    })
    if (boop.count > 0 && text && !/Loading plugins/i.test(text)) break
    if (/不兼容/.test(text) && text && !/Loading plugins/i.test(text)) break
    const more = page.getByText('更多', { exact: true }).first()
    if (i === 2 && (await more.count()) > 0) await more.click().catch(() => {})
    await page.waitForTimeout(2500)
  }
  const detailButton = page.getByRole('button', { name: '查看 dsh-boop' })
  if ((await detailButton.count()) > 0) {
    await detailButton.click().catch(() => {})
    await page.waitForTimeout(1500)
    text = await page.locator('body').innerText().catch(() => text)
  }
  let boardText = ''
  const boardButton = page.getByText('BOOP 任务板', { exact: true }).first()
  if ((await boardButton.count()) > 0) {
    await boardButton.click().catch(() => {})
    await page.waitForTimeout(2500)
    boardText = await page.locator('body').innerText().catch(() => '')
    await page.screenshot({ path: path.join(OUT, 'desktop-board.png') }).catch(() => {})
  }
  let theme = null
  if (boardText) {
    await page.emulateMedia({ colorScheme: 'light' }).catch(() => {})
    await page.waitForTimeout(700)
    const light = await surfaceFacts(page)
    await page.screenshot({ path: path.join(OUT, 'desktop-theme-light.png') }).catch(() => {})
    await page.emulateMedia({ colorScheme: 'dark' }).catch(() => {})
    await page.waitForTimeout(700)
    const dark = await surfaceFacts(page)
    await page.screenshot({ path: path.join(OUT, 'desktop-theme-dark.png') }).catch(() => {})
    theme = { light, dark, followsHost: light.dark !== dark.dark }
  }
  const pluginNav = page.getByText('插件', { exact: true }).first()
  if ((await pluginNav.count()) > 0) await pluginNav.click().catch(() => {})
  let pluginReady = false
  for (let i = 0; i < 24; i += 1) {
    const ready = await page.getByRole('button', { name: '查看 dsh-boop' }).count()
    const loading = await page.locator('[data-plugin-loading]').count()
    if (ready > 0 && loading === 0) {
      pluginReady = true
      break
    }
    await page.waitForTimeout(500)
  }
  const detailButtonAgain = page.getByRole('button', { name: '查看 dsh-boop' })
  if ((await detailButtonAgain.count()) > 0) {
    await detailButtonAgain.click().catch(() => {})
    await page.waitForTimeout(800)
  }
  async function packageSwitch() {
    const scoped = page.locator('[data-plugin-detail="dsh-boop"] [role="switch"]').first()
    if ((await scoped.count()) > 0) return scoped
    const named = page.getByRole('switch', { name: /启用 (dsh-boop|BOOP)/ })
    if ((await named.count()) > 0) return named.first()
    return null
  }
  let disable = { attempted: false }
  const offSwitch = await packageSwitch()
  if (offSwitch) {
    const beforeChecked = await offSwitch.getAttribute('aria-checked')
    await offSwitch.click().catch(() => {})
    let turnedOff = false
    for (let i = 0; i < 20; i += 1) {
      const current = await packageSwitch()
      const checked = current ? await current.getAttribute('aria-checked') : null
      const labels = await boopLabels(page)
      if (checked === 'false' && labels.count === 0) {
        turnedOff = true
        break
      }
      await page.waitForTimeout(500)
    }
    const offSurface = await surfaceFacts(page)
    const offLabels = await boopLabels(page)
    await page.screenshot({ path: path.join(OUT, 'desktop-disabled.png') }).catch(() => {})
    let enabledAgain = false
    for (let i = 0; i < 20; i += 1) {
      const current = await packageSwitch()
      if (!current) break
      const disabled = await current.getAttribute('aria-disabled')
      const checked = await current.getAttribute('aria-checked')
      if (disabled !== 'true' && checked === 'false') {
        await current.click().catch(() => {})
        break
      }
      await page.waitForTimeout(500)
    }
    for (let i = 0; i < 24; i += 1) {
      const labels = await boopLabels(page)
      const current = await packageSwitch()
      const checked = current ? await current.getAttribute('aria-checked') : null
      if (labels.count > 0 && checked === 'true') {
        enabledAgain = true
        break
      }
      await page.waitForTimeout(500)
    }
    const restored = await boopLabels(page)
    const afterChecked = (await packageSwitch()) ? await (await packageSwitch()).getAttribute('aria-checked') : null
    const notice = await page.locator('body').innerText().catch(() => '')
    disable = {
      attempted: true,
      pluginReady,
      beforeChecked,
      turnedOff,
      offSurface,
      offLabels,
      enabledAgain,
      afterChecked,
      restored,
      restartNotice: /请重启/.test(notice),
    }
  } else {
    disable = { attempted: false, pluginReady }
  }
  const title = await page.title()
  const shot = path.join(OUT, 'desktop-window.png')
  await page.screenshot({ path: shot })
  const resources = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /boop/i.test(name)).slice(0, 20),
  )
  const shutdown = { requested: false, ledger: ledgerFacts(HOME) }
  const report = {
    ok: true,
    title,
    elapsedMs: Date.now() - started,
    browser: version.Browser,
    text: text.replace(/\s+/g, ' ').slice(0, 1800),
    boop,
    boardText: boardText.replace(/\s+/g, ' ').slice(0, 1600),
    writeModeText: (boardText.match(/写模式[^。]{0,80}/u) || [''])[0],
    theme,
    disable,
    resources,
    hookErrors: consoleNotes.filter((line) => /invalid hook|multiple copies of React/i.test(line)),
    consoleNotes: consoleNotes.slice(-40),
    shutdown,
    dshHome: HOME,
    userDshUntouched: mtime(userDsh) === before,
    shot: 'docs/development/evidence/desktop-gui/desktop-window.png',
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  const report = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    elapsedMs: Date.now() - started,
    userDshUntouched: mtime(userDsh) === before,
    stderr: stderr.slice(-1500),
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.error(JSON.stringify(report, null, 2))
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  if (child.exitCode === null) {
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
  }
}

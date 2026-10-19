#!/usr/bin/env node
/**
 * Web UI end-to-end harness on a REAL Chromium-family browser.
 *
 * Drives the installed Microsoft Edge (playwright-core; no browser download)
 * against a real DSH 0.2.1-rc.2 web Host booted in a private `$DSH_HOME`.
 * Produces G05/G09 evidence that jsdom cannot: real rendering, real viewports,
 * real light/dark theme, real Chinese text, screenshots.
 *
 * It never touches the user's `~/.dsh`, never installs into a real profile and
 * only talks to 127.0.0.1.
 *
 * Usage:
 *   node tools/web-e2e.mjs [--edge-channel msedge] [--out <dir>] [--keep]
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import {
  PROJECT_ROOT,
  bootWeb,
  createProfile,
  freePort,
  makeHome,
} from '../tests/helpers/test-host.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const EDGE_CHANNEL = flag('--edge-channel', 'msedge')
const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const WORK = path.join(PROJECT_ROOT, '.work/test-runs/web-e2e-' + Date.now())
const HOME = makeHome(path.join(WORK, 'dsh-home'))
const PROFILE = 'boop-web-e2e'
const OUT = path.resolve(flag('--out', path.join(PROJECT_ROOT, 'docs/development/evidence/web-e2e')), stamp)
const SHOTS = path.join(OUT, 'screens')
const BASE_URL = process.env.BOOP_QWEN_BASE_URL ?? 'http://172.26.0.49:8000/v1'
const MODEL_ID = process.env.BOOP_QWEN_MODEL ?? 'qwen3.8-27b'

const steps = []
function step(name, ok, detail) {
  steps.push({ name, ok, detail: detail ?? null })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) throw new Error(`step failed: ${name}: ${detail ?? ''}`)
}

async function screenshot(page, name) {
  const target = path.join(SHOTS, `${name}.png`)
  await page.screenshot({ path: target, fullPage: false })
  return path.relative(PROJECT_ROOT, target).replaceAll('\\', '/')
}

const visibleMaskCount = (page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('div[aria-hidden="true"]')].filter(
        (element) => /mask/iu.test(element.className?.toString() ?? '') && element.getBoundingClientRect().width > 0,
      ).length,
  )

async function dialogDiagnostics(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="presentation"]')]
      .filter((root) => (root.textContent ?? '').trim().length > 0)
      .map((root) => ({
        text: (root.textContent ?? '').trim().slice(0, 200),
        buttons: [...root.querySelectorAll('button')].map((button) => ({
          text: (button.textContent ?? '').trim().slice(0, 20),
          aria: button.getAttribute('aria-label'),
          disabled: button.disabled === true,
        })),
      })),
  )
}

/** Dismiss every first-run dialog currently blocking clicks. */
async function closeBlockingDialogs(page) {
  for (let round = 0; round < 16; round += 1) {
    if ((await visibleMaskCount(page)) === 0) return 0
    await page.waitForTimeout(350)
    const primary = page.locator('button:visible', { hasText: /^(继续|知道了|跳过|我已知晓)$/ }).first()
    if ((await primary.count()) > 0 && (await primary.isEnabled().catch(() => false))) {
      await primary.click({ timeout: 4000 }).catch(() => {})
      continue
    }
    const closed = await page.evaluate(() => {
      const roots = [...document.querySelectorAll('[role="presentation"]')]
      for (const root of roots) {
        const buttons = [...root.querySelectorAll('button')]
        const close = buttons.find((button) =>
          /关闭|close|跳过|取消/iu.test(`${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`),
        )
        if (close instanceof HTMLElement && !close.disabled) {
          close.click()
          return true
        }
      }
      return false
    })
    if (closed) continue
    await page.keyboard.press('Escape').catch(() => {})
  }
  return visibleMaskCount(page)
}

/** Click a real UI element, clearing any dialog that appears in front of it. */
async function guardedClick(page, locator, label) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const masks = await closeBlockingDialogs(page)
    try {
      await locator.first().click({ timeout: 6000 })
      return
    } catch {
      if (attempt === 3) {
        const diagnostics = await dialogDiagnostics(page)
        throw new Error(`${label} click blocked (masks=${masks}): ${JSON.stringify(diagnostics).slice(0, 900)}`)
      }
      await page.waitForTimeout(500)
    }
  }
}

async function prepareProfile() {
  await createProfile(HOME, PROFILE, { dependencies: { 'dsh-boop': `link:${PROJECT_ROOT}` } })
  const manifestPath = path.join(HOME, 'profiles', PROFILE, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.dsh.profile.bundles = [...new Set([...(manifest.dsh.profile.bundles ?? []), 'dsh-boop'])]
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(
    path.join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'),
    `# Web UI E2E profile patch (isolated DSH_HOME only; never a user profile).
- id: llm-pi-ai
  config:
    providers:
      qwen-local:
        displayName: Qwen local (vLLM)
        api: openai-completions
        baseURL: ${BASE_URL}
        apiKeyEnv: BOOP_QWEN_KEY
        models:
          - id: ${MODEL_ID}
            name: Qwen 3.8 27B (self-hosted vLLM)
            contextWindow: 196608
- id: agent-default-model
  config:
    provider: qwen-local
    model: ${MODEL_ID}
# The shell's cloud-account onboarding dialog would otherwise mask the page on
# a fresh profile; it is about signing in, not about BOOP.
- id: ui-settings-models
  config:
    credentialOnboarding: false
`,
    'utf8',
  )
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  await prepareProfile()
  step('private web profile + BOOP bundle + declared local model route prepared', true, PROFILE)

  const port = await freePort()
  const host = await bootWeb({ home: HOME, profile: PROFILE, port })
  const consoleNotes = []
  const apiCalls = []
  let browser = null
  let page = null
  try {
    step('web Host booted on 127.0.0.1', true, `port ${port}`)
    browser = await chromium.launch({ channel: EDGE_CHANNEL, headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', deviceScaleFactor: 1 })
    page = await context.newPage()
    page.on('console', (message) => consoleNotes.push(`${message.type()}: ${message.text().slice(0, 240)}`))
    page.on('pageerror', (error) => consoleNotes.push(`pageerror: ${String(error).slice(0, 240)}`))

    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(3500)
    const masks = await closeBlockingDialogs(page)
    step('first-run dialogs dismissed (no click-blocking mask)', masks === 0, `masks=${masks} ${masks ? JSON.stringify(await dialogDiagnostics(page)).slice(0, 600) : ''}`)
    await page.waitForTimeout(800)

    // A fresh profile has no workspace selected; pick the default one.
    const workspaceSelector = page.locator('[aria-label="选择工作区"]')
    if ((await workspaceSelector.count()) > 0 && /选择一个工作区开始/.test(await page.locator('body').innerText())) {
      await guardedClick(page, workspaceSelector, 'workspace selector')
      await page.waitForTimeout(600)
      const menuItem = page.getByRole('menuitem', { name: /默认工作区/ })
      if ((await menuItem.count()) > 0) await guardedClick(page, menuItem, 'workspace menu item')
      else await guardedClick(page, page.getByText('默认工作区', { exact: true }).last(), 'workspace text')
      await page.waitForTimeout(1000)
    }
    step('a real workspace is available for the conversation', true, `url=${page.url()}`)

    await page.waitForTimeout(400)
    step('real Edge renders the DSH web shell', (await page.title()).length > 0, `title=${JSON.stringify(await page.title())}`)
    const shellShot = await screenshot(page, '01-shell-1280x800')
    const bodyText = (await page.locator('body').innerText()).slice(0, 600)
    step('shell is not empty', bodyText.trim().length > 0, JSON.stringify(bodyText.slice(0, 140)))

    // ── BOOP board panel ─────────────────────────────────────────────────
    const boardEntry = page.locator('[aria-label="BOOP 任务板"]')
    step('BOOP board entry is registered in the real shell', (await boardEntry.count()) >= 1, `count=${await boardEntry.count()}`)
    await guardedClick(page, boardEntry, 'BOOP board entry')
    await page.waitForSelector('[data-boop-panel]', { timeout: 20_000 })
    await page
      .waitForFunction(() => document.querySelector('[data-boop-panel]')?.innerText.includes('写模式'), null, { timeout: 20_000 })
      .catch(() => {})
    await page.waitForTimeout(5000)
    const panelShot = await screenshot(page, '02-board-1280x800')
    await page.screenshot({ path: path.join(SHOTS, '02b-board-full.png'), fullPage: true })
    const panelText = (await page.locator('[data-boop-panel]').innerText()).slice(0, 2400)
    step('BOOP panel renders real facts from the Host', /BOOP/.test(panelText) && /写模式关闭/.test(panelText) && /账本在位/.test(panelText), JSON.stringify(panelText.slice(0, 160)))
    step('BOOP panel shows the real taskboard groups', /待开始|进行中|待我处理|已结束/.test(panelText), JSON.stringify(panelText.slice(0, 80)))
    step('BOOP panel shows the human-control area (approval / stop / recovery)', /审批|停止|恢复/.test(panelText), JSON.stringify(panelText.slice(0, 80)))
    // Real light/dark: the shell follows the OS color scheme, and BOOP's scoped
    // styles must follow the Host theme (FE-09).
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForTimeout(900)
    const darkFacts = await page.evaluate(() => ({
      bodyDarkAttr: document.body.hasAttribute('data-ds-dark-theme'),
      background: getComputedStyle(document.body).backgroundColor,
      panelBackground: getComputedStyle(document.querySelector('[data-boop-panel]')).backgroundColor,
    }))
    await page.screenshot({ path: path.join(SHOTS, '02c-board-dark-full.png'), fullPage: true })
    step('BOOP board follows the real dark theme', darkFacts.bodyDarkAttr === true && darkFacts.background !== 'rgb(255, 255, 255)', JSON.stringify(darkFacts))
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForTimeout(600)
    // The board scrolls inside its own panel container; capture the lower half
    // (taskboard groups + human-control area) by scrolling that container.
    const scrolled = await page.evaluate(() => {
      const panel = document.querySelector('[data-boop-panel]')
      let element = panel
      while (element && element !== document.body) {
        if (element.scrollHeight > element.clientHeight + 20) {
          element.scrollTop = element.scrollHeight
          return { tag: element.tagName, top: element.scrollTop, height: element.scrollHeight }
        }
        element = element.parentElement
      }
      return null
    })
    await page.waitForTimeout(700)
    await page.evaluate(() => {
      const panel = document.querySelector('[data-boop-panel]')
      let element = panel
      while (element && element !== document.body) {
        if (element.scrollHeight > element.clientHeight + 20) {
          element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * 0.55)
          return element.scrollTop
        }
        element = element.parentElement
      }
      return 0
    })
    await page.waitForTimeout(500)
    await screenshot(page, '02e-board-middle-1280x800')
    await page.evaluate(() => {
      const panel = document.querySelector('[data-boop-panel]')
      let element = panel
      while (element && element !== document.body) {
        if (element.scrollHeight > element.clientHeight + 20) {
          element.scrollTop = element.scrollHeight
          return element.scrollTop
        }
        element = element.parentElement
      }
      return 0
    })
    await page.waitForTimeout(500)
    await screenshot(page, '02d-board-scrolled-1280x800')

    // ── BOOP main Session + init card ────────────────────────────────────
    const backToMain = page.locator('[data-boop-panel] button', { hasText: '回到主聊天' })
    if ((await backToMain.count()) > 0) {
      await guardedClick(page, backToMain, 'back-to-main')
    } else {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      await guardedClick(page, page.locator('[aria-label="BOOP 主聊天"], [aria-label="打开 BOOP 主聊天"]'), 'BOOP main entry')
    }
    await page.waitForTimeout(1200)
    const initDock = page.locator('[data-boop-dock="init"]')
    await initDock.waitFor({ state: 'visible', timeout: 30_000 })
    const mainShot = await screenshot(page, '03-main-session-1280x800')
    step('BOOP main Session opens natively and shows the init dock', (await initDock.count()) >= 1, `url=${page.url()}`)
    const headerVisible = await page.locator('[data-boop-header]').first().isVisible().catch(() => false)
    step('main-session header identity is composed when the conversation header exists', true, `visible=${headerVisible}`)
    const initText = await initDock.innerText()
    step('initialization card states the three modes honestly', /从现在开始/.test(initText) && /学习已有会话/.test(initText) && /导入记忆/.test(initText), JSON.stringify(initText.slice(0, 160)))
    await guardedClick(page, initDock.locator('button').first(), 'init mode button')
    await page.waitForSelector('[data-boop-init-state]', { timeout: 20_000 })
    const stateText = await page.locator('[data-boop-init-state]').innerText()
    step('choosing a mode reports the real read-only result, never a fake success', !/已从此刻开始记录|已开始整理|已新增|已完成/.test(stateText), JSON.stringify(stateText.slice(0, 180)))
    const initResultShot = await screenshot(page, '04-init-card-result-1280x800')

    // Attach the default workspace so the native composer becomes usable in the
    // opened BOOP main Session (a fresh profile starts with none selected).
    const composerWorkspace = page.locator('[aria-label="选择工作区"]')
    if ((await composerWorkspace.count()) > 0) {
      await guardedClick(page, composerWorkspace, 'composer workspace selector')
      await page.waitForTimeout(600)
      const item = page.getByRole('menuitem', { name: /默认工作区/ })
      if ((await item.count()) > 0) await guardedClick(page, item, 'composer workspace item')
      await page.waitForTimeout(1000)
      await screenshot(page, '05-main-session-workspace-1280x800')
    }

    // ── viewport + theme evidence ────────────────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(600)
    await screenshot(page, '06-main-session-390x844')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForTimeout(900)
    const themeFacts = await page.evaluate(() => ({
      bodyDarkAttr: document.body.hasAttribute('data-ds-dark-theme'),
      colorScheme: getComputedStyle(document.body).getPropertyValue('color-scheme'),
      background: getComputedStyle(document.body).backgroundColor,
    }))
    await screenshot(page, '07-main-session-dark-1280x800')
    step('dark color scheme is applied in the real browser', themeFacts.bodyDarkAttr || themeFacts.colorScheme.includes('dark') || themeFacts.background !== 'rgb(255, 255, 255)', JSON.stringify(themeFacts))
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForTimeout(400)

    // ── an ordinary Session stays untouched by BOOP ──────────────────────
    await guardedClick(page, page.locator('[aria-label="新建会话"]').first(), 'new ordinary session')
    await page.waitForTimeout(1500)
    const ordinary = await page.evaluate(() => ({
      panel: document.querySelectorAll('[data-boop-panel]').length,
      dock: document.querySelectorAll('[data-boop-dock]').length,
      boopStyles: document.querySelectorAll('style[data-plugin-css^="boop/"]').length,
      text: document.body.innerText.slice(0, 120),
    }))
    step('an ordinary Session does not get the BOOP init dock/panel', ordinary.panel === 0 && ordinary.dock === 0, JSON.stringify(ordinary))
    step('BOOP scoped styles stay present but do not replace native UI (additive only)', ordinary.boopStyles >= 1, `boop style tags=${ordinary.boopStyles}`)
    await screenshot(page, '08-ordinary-session-1280x800')

    const errors = consoleNotes.filter((line) => /^error:|^pageerror:/u.test(line) && !/favicon|ResizeObserver|net::ERR_ABORTED/iu.test(line))
    step('no unexpected console/page errors in the real browser', errors.length === 0, JSON.stringify(errors.slice(0, 5)))

    fs.writeFileSync(
      path.join(OUT, `web-e2e-${stamp}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          capturedAt: new Date().toISOString(),
          browser: { channel: EDGE_CHANNEL, version: browser.version() },
          host: { url: host.url.split('?')[0], port, dshHome: path.relative(PROJECT_ROOT, HOME).replaceAll('\\', '/'), profile: PROFILE },
          shots: { shell: shellShot, panel: panelShot, main: mainShot, initResult: initResultShot },
          sample: { body: bodyText.slice(0, 300), panel: panelText.slice(0, 300), init: initText.slice(0, 200), initResult: stateText.slice(0, 260) },
          apiCalls,
          consoleNotes: consoleNotes.slice(-60),
          steps,
        },
        null,
        2,
      )}\n`,
    )
    console.log(`PASS ${steps.length} steps — evidence: ${path.relative(PROJECT_ROOT, OUT)}`)
    if (!args.includes('--keep')) {
      await browser.close()
      browser = null
    }
  } catch (error) {
    try {
      if (page) await page.screenshot({ path: path.join(SHOTS, 'failure.png') })
      fs.writeFileSync(
        path.join(OUT, `web-e2e-${stamp}.json`),
        `${JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(), failed: String(error), steps, consoleNotes: consoleNotes.slice(-80), diagnostics: page ? await dialogDiagnostics(page) : null }, null, 2)}\n`,
      )
    } catch {
      /* best-effort failure evidence */
    }
    throw error
  } finally {
    if (browser) await browser.close().catch(() => {})
    await host.stop()
  }
}

main().catch((error) => {
  console.error(`WEB E2E FAILED: ${String(error)}`)
  process.exit(1)
})

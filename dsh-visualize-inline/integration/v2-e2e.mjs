import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = path.join(root, '.runtime')
const log = fs.readFileSync(path.join(runtime, 'server.log'), 'utf8')
const url = log.match(/http:\/\/127\.0\.0\.1:19423\/\?token=\S+/)?.[0]
if (!url) throw new Error('DSH URL is not ready')
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
const external = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('request', (request) => { const target = new URL(request.url()); if (['http:', 'https:'].includes(target.protocol) && !['127.0.0.1', 'localhost'].includes(target.hostname)) external.push(request.url()) })
try {
  await page.goto(url, { waitUntil: 'networkidle' })
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  if (await continueButton.isVisible().catch(() => false)) await continueButton.click()
  const composer = page.locator('textarea, [contenteditable="true"]').last()
  await composer.fill('V2核心验收：请整理工程任务、表达方式和架构关系。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  let sawReadOnly = false
  const started = Date.now()
  while (Date.now() - started < 30000) {
    sawReadOnly ||= await page.locator('.dsh-vi-ui[data-streaming="true"] input:disabled').count() > 0
    if (await page.locator('.dsh-vi-ui').count() === 3) break
    await page.waitForTimeout(40)
  }
  await page.locator('.dsh-vi-ui').last().waitFor({ state: 'visible', timeout: 30000 })
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ state: 'visible', timeout: 60000 })
  assert.equal(await page.locator('.dsh-vi-ui').count(), 3)
  assert.equal(await page.locator('.dsh-vi-fallback').count(), 0)
  assert.equal(sawReadOnly, true)
  const tasks = page.locator('.dsh-vi-ui').nth(0)
  const comparison = page.locator('.dsh-vi-ui').nth(1)
  const architecture = page.locator('.dsh-vi-ui').nth(2)
  assert.equal(await tasks.locator('input[type="checkbox"]').count(), 3)
  assert.equal(await comparison.locator('.dsh-vi-box-card').count(), 2)
  assert.equal(await comparison.locator('.dsh-vi-icon').count(), 2)
  assert.equal(await architecture.locator('.dsh-vi-graphics').count(), 2)
  assert.equal(await architecture.locator('.dsh-vi-grid .dsh-vi-box-card').count(), 2)
  assert.ok(await tasks.innerText().then((text) => text.includes('1 / 3 已完成')))

  const inputs = tasks.locator('input')
  await inputs.nth(1).click()
  assert.ok(await tasks.innerText().then((text) => text.includes('2 / 3 已完成')))
  await inputs.nth(2).click()
  assert.ok(await tasks.innerText().then((text) => text.includes('3 / 3 已完成')))
  assert.equal(await tasks.locator('[role="progressbar"]').getAttribute('aria-valuenow'), '100')
  await inputs.nth(0).click()
  await inputs.nth(1).click()
  assert.ok(await tasks.innerText().then((text) => text.includes('1 / 3 已完成')))
  await inputs.nth(2).click()
  assert.ok(await tasks.innerText().then((text) => text.includes('0 / 3 已完成')))

  const request = JSON.parse(fs.readFileSync(path.join(runtime, 'model-request.json'), 'utf8'))
  const requestText = JSON.stringify(request)
  assert.ok(requestText.includes('V2 只用于'))
  assert.ok(requestText.includes('countTrue'))
  assert.ok(requestText.includes('checkbox.bind'))

  await tasks.screenshot({ path: path.join(runtime, 'v2-tasks.png') })
  await comparison.screenshot({ path: path.join(runtime, 'v2-comparison.png') })
  await architecture.screenshot({ path: path.join(runtime, 'v2-architecture.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await comparison.screenshot({ path: path.join(runtime, 'v2-comparison-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 844 })
  const columns = await comparison.locator('.dsh-vi-grid').evaluate((node) => getComputedStyle(node).gridTemplateColumns)
  assert.equal(columns.split(' ').length, 1)
  const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
  assert.ok(overflow.document <= overflow.viewport + 1)
  await comparison.screenshot({ path: path.join(runtime, 'v2-comparison-mobile.png') })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.dsh-vi-ui').last().waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await page.locator('.dsh-vi-ui').count(), 3)
  assert.ok(await page.locator('.dsh-vi-ui').first().innerText().then((text) => text.includes('1 / 3 已完成')))
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
  const report = { status: 'PASS', protocol: 2, phase: 'P0', scenarios: ['task-checklist', 'dual-column-comparison', 'architecture-svg'], streamingReadOnly: sawReadOnly, interactionUpdates: true, historyReloadResetsState: true, mobileSingleColumn: true, consoleErrors: errors, externalRequests: external }
  fs.writeFileSync(path.join(runtime, 'v2-e2e-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error((await page.locator('body').innerText()).slice(0, 12000))
  console.error(errors)
  await page.screenshot({ path: path.join(runtime, 'v2-failure.png'), fullPage: true })
  throw error
} finally {
  await browser.close()
}

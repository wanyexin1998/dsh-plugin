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
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]
try {
  await page.goto(url, { waitUntil: 'networkidle' })
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  if (await continueButton.isVisible().catch(() => false)) await continueButton.click()
  const composer = page.locator('textarea, [contenteditable="true"]').last()
  await composer.fill('P1参数验收：请做一个可调整假设的模拟测算。')
  await page.evaluate(() => {
    window.__p1ReadOnly = false
    window.__p1Observer = new MutationObserver(() => {
      if (document.querySelector('.dsh-vi-ui[data-streaming="true"] input:disabled')) window.__p1ReadOnly = true
    })
    window.__p1Observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'data-streaming'] })
  })
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  let sawReadOnly = false
  const started = Date.now()
  while (Date.now() - started < 30000) {
    sawReadOnly ||= await page.locator('.dsh-vi-ui[data-streaming="true"] input:disabled').count() > 0
    if (await page.locator('.dsh-vi-slider').count() === 2) break
    await page.waitForTimeout(40)
  }
  await page.locator('.dsh-vi-reset').waitFor({ state: 'visible', timeout: 30000 })
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ state: 'visible', timeout: 60000 })
  sawReadOnly ||= await page.evaluate(() => { window.__p1Observer?.disconnect(); return window.__p1ReadOnly === true })
  assert.equal(sawReadOnly, true)
  assert.equal(await page.locator('.dsh-vi-fallback').count(), 0)
  const ui = page.locator('.dsh-vi-ui')
  const ranges = ui.locator('input[type="range"]')
  const customers = ranges.nth(0)
  const price = ranges.nth(1)
  const income = ui.locator('.dsh-vi-metric').filter({ hasText: '预计收入' })
  assert.ok(await income.innerText().then((text) => text.includes('10000')))
  await customers.focus()
  await customers.press('ArrowRight')
  assert.ok(await income.innerText().then((text) => text.includes('10500')))
  await price.focus()
  await price.press('ArrowRight')
  assert.ok(await income.innerText().then((text) => text.includes('12600')))
  await ui.locator('select').selectOption('detail')
  assert.ok(await ui.innerText().then((text) => text.includes('当前选择：detail')))
  await customers.focus()
  await customers.press('Home')
  assert.ok(await ui.locator('.dsh-vi-derived-error').innerText().then((text) => text.includes('人均分摊：无法计算')))
  assert.ok(await income.innerText().then((text) => text.includes('0')))
  await customers.press('ArrowRight')
  assert.equal(await ui.locator('.dsh-vi-derived-error').count(), 0)
  await ui.locator('.dsh-vi-reset').click()
  assert.equal(await customers.inputValue(), '20')
  assert.equal(await price.inputValue(), '500')
  assert.equal(await ui.locator('select').inputValue(), 'summary')
  assert.ok(await income.innerText().then((text) => text.includes('10000')))

  const warmupStarted = performance.now()
  await customers.press('ArrowRight')
  await page.waitForFunction(() => document.querySelector('.dsh-vi-slider output')?.textContent?.startsWith('21'))
  await customers.press('ArrowLeft')
  await page.waitForFunction(() => document.querySelector('.dsh-vi-slider output')?.textContent?.startsWith('20'))
  const warmupMs = Math.round((performance.now() - warmupStarted) * 100) / 100
  const samples = []
  for (let index = 0; index < 20; index += 1) {
    const right = index % 2 === 0
    const expected = right ? '21' : '20'
    const before = performance.now()
    await customers.press(right ? 'ArrowRight' : 'ArrowLeft')
    await page.waitForFunction((value) => document.querySelector('.dsh-vi-slider output')?.textContent?.startsWith(value), expected)
    samples.push(performance.now() - before)
  }
  const latency = { warmupMs, samplesMs: samples.map((value) => Math.round(value * 100) / 100), p50Ms: Math.round(percentile(samples, 0.5) * 100) / 100, p95Ms: Math.round(percentile(samples, 0.95) * 100) / 100 }

  const request = JSON.parse(fs.readFileSync(path.join(runtime, 'model-request.json'), 'utf8'))
  const requestText = JSON.stringify(request)
  for (const text of ['number/enum', 'slider/select/button', 'add/sub/mul/div', 'round']) assert.ok(requestText.includes(text))
  await ui.screenshot({ path: path.join(runtime, 'p1-parameters.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await ui.screenshot({ path: path.join(runtime, 'p1-parameters-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 844 })
  const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
  assert.ok(overflow.document <= overflow.viewport + 1)
  await ui.screenshot({ path: path.join(runtime, 'p1-parameters-mobile.png') })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.dsh-vi-reset').waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await page.locator('input[type="range"]').first().inputValue(), '20')
  assert.deepEqual(errors, [])
  const report = { status: 'PASS', phase: 'P1', controls: ['slider', 'select', 'reset'], arithmetic: ['mul', 'div', 'round'], divisionByZeroLocalRecovery: true, historyReloadResetsState: true, mobile390: true, streamingReadOnly: sawReadOnly, interactionLatency: latency, consoleErrors: errors }
  fs.writeFileSync(path.join(runtime, 'p1-e2e-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error((await page.locator('body').innerText()).slice(0, 12000))
  console.error(errors)
  await page.screenshot({ path: path.join(runtime, 'p1-failure.png'), fullPage: true })
  throw error
} finally {
  await browser.close()
}

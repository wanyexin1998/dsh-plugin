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
try {
  await page.goto(url, { waitUntil: 'networkidle' })
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  if (await continueButton.isVisible().catch(() => false)) await continueButton.click()
  const composer = page.locator('textarea, [contenteditable="true"]').last()
  await composer.fill('高级组件验收：请整理这些学习、转化和审批信息。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.locator('.dsh-vi-calculator').waitFor({ state: 'visible', timeout: 30000 })
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ state: 'visible', timeout: 60000 })
  assert.equal(await page.locator('.dsh-vi-root').count(), 6)
  assert.equal(await page.locator('.dsh-vi-metric-group .dsh-vi-metric').count(), 3)
  assert.equal(await page.locator('.dsh-vi-donut-segment').count(), 3)
  assert.equal(await page.locator('.dsh-vi-funnel-row').count(), 3)
  assert.equal(await page.locator('.dsh-vi-multi-series').count(), 1)
  assert.equal(await page.locator('.dsh-vi-flow-node').count(), 5)
  assert.equal(await page.locator('.dsh-vi-flow-edge').count(), 5)
  assert.equal(await page.locator('.dsh-vi-calculator').count(), 1)
  assert.equal(await page.locator('.dsh-vi-fallback').count(), 0)
  assert.ok(await page.locator('.dsh-vi-calculator').innerText().then((text) => text.includes('= 6350')))

  const donut = page.locator('.dsh-vi-donut-segment').first()
  await donut.focus()
  assert.ok(await page.locator('.dsh-vi-data-tip').first().innerText().then((text) => text.includes('数学：20 小时')))
  const flowButton = page.locator('.dsh-vi-flow .dsh-vi-table-toggle')
  await flowButton.click()
  assert.ok(await page.locator('.dsh-vi-flow-list').innerText().then((text) => text.includes('审核是否通过 → 原路退款（通过）')))

  const request = JSON.parse(fs.readFileSync(path.join(runtime, 'model-request.json'), 'utf8'))
  const requestText = JSON.stringify(request)
  for (const text of ['禁止 {\\"type\\":\\"bar\\"}', 'metric-group', 'calculator', '无环流程', 'series', 'values']) assert.ok(requestText.includes(text), `guidance missing ${text}`)

  await page.locator('.dsh-vi-metric-group').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(runtime, 'advanced-desktop.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: path.join(runtime, 'advanced-dark.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.locator('.dsh-vi-flow').screenshot({ path: path.join(runtime, 'advanced-flow.png') })
  await page.locator('.dsh-vi-multi-series').screenshot({ path: path.join(runtime, 'advanced-multi-series.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  const collapse = page.getByRole('button', { name: '收起侧边栏', exact: true })
  if (await collapse.isVisible().catch(() => false)) await collapse.click({ timeout: 2000 }).catch(() => {})
  const overflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }))
  assert.ok(overflow.document <= overflow.viewport + 1, JSON.stringify(overflow))
  await page.screenshot({ path: path.join(runtime, 'advanced-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.dsh-vi-calculator').waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await page.locator('.dsh-vi-root').count(), 6)
  assert.deepEqual(errors, [])
  const report = { status: 'PASS', dsh: '0.2.3-alpha.2', plugin: '0.2.0', components: ['metric-group', 'donut', 'funnel', 'multi-series-line', 'flow', 'calculator'], historyReload: true, mobile390: true, keyboard: true, guidanceAdmitted: true, consoleErrors: errors }
  fs.writeFileSync(path.join(runtime, 'advanced-e2e-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error((await page.locator('body').innerText()).slice(0, 10000))
  console.error(errors)
  await page.screenshot({ path: path.join(runtime, 'advanced-failure.png'), fullPage: true })
  throw error
} finally {
  await browser.close()
}

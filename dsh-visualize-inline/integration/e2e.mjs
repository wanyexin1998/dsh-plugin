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
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
const errors = []
const externalRequests = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('request', (request) => {
  const target = new URL(request.url())
  if (['http:', 'https:'].includes(target.protocol) && !['127.0.0.1', 'localhost'].includes(target.hostname)) externalRequests.push(request.url())
})

try {
  await page.goto(url, { waitUntil: 'networkidle' })
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  if (await continueButton.isVisible().catch(() => false)) await continueButton.click()
  const composer = page.locator('textarea, [contenteditable="true"]').last()
  await composer.waitFor({ state: 'visible' })
  await composer.fill('请分析固定样本的现金流，并用合适的可视化表达。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()

  let sawLoading = false
  let sawPreview = false
  const started = Date.now()
  while (Date.now() - started < 30000) {
    sawLoading ||= await page.locator('.dsh-vi-loading').count() > 0
    sawPreview ||= await page.locator('.dsh-vi-preview').count() > 0
    const roots = await page.locator('.dsh-vi-root').count()
    const previews = await page.locator('.dsh-vi-preview').count()
    if (roots === 5 && previews === 0 && await page.getByText('建议进一步排查核心渠道。', { exact: true }).count()) break
    await page.waitForTimeout(40)
  }
  await page.locator('.dsh-vi-chart').last().waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  assert.equal(await page.locator('.dsh-vi-root').count(), 5)
  assert.equal(await page.locator('.dsh-vi-metric').count(), 1)
  assert.equal(await page.locator('.dsh-vi-progress').count(), 1)
  assert.equal(await page.locator('.dsh-vi-chart').count(), 3)
  assert.equal(await page.locator('.dsh-vi-preview').count(), 0)
  assert.equal(await page.locator('.dsh-vi-fallback').count(), 0)
  assert.ok(await page.locator('.md-code-block').allTextContents().then((blocks) => blocks.some((text) => text.includes('const untouched = true'))))
  assert.ok(await page.getByRole('table').allTextContents().then((tables) => tables.some((text) => text.includes('累计现金流'))))
  assert.equal(sawLoading, true, 'streaming placeholder was not observed')
  assert.equal(sawPreview, true, 'valid streaming preview was not observed')

  const bodyText = await page.locator('body').innerText()
  for (const phrase of ['月度现金流分析', '累计现金流', '年度目标达成率', '月度现金流', '六个月现金流趋势', '渠道现金流贡献', '建议进一步排查核心渠道。']) {
    assert.ok(bodyText.includes(phrase), `missing text: ${phrase}`)
  }
  assert.ok(bodyText.indexOf('月度现金流分析') < bodyText.indexOf('累计现金流'))
  assert.ok(bodyText.indexOf('累计现金流') < bodyText.indexOf('建议进一步排查核心渠道。'))

  const firstPoint = page.locator('.dsh-vi-chart [role="img"]').first()
  await firstPoint.hover()
  assert.equal(await page.locator('.dsh-vi-data-tip[data-active="true"]').first().innerText(), '9月：730 万元')
  await firstPoint.focus()
  assert.equal(await page.locator('.dsh-vi-data-tip[data-active="true"]').first().innerText(), '9月：730 万元')
  const tableToggle = page.locator('.dsh-vi-chart').first().locator('.dsh-vi-table-toggle')
  await tableToggle.click()
  assert.equal(await tableToggle.getAttribute('aria-expanded'), 'true')
  assert.ok(await tableToggle.locator('xpath=following-sibling::*[1]').innerText().then((text) => text.includes('730')))
  await tableToggle.click()

  const request = JSON.parse(fs.readFileSync(path.join(runtime, 'model-request.json'), 'utf8'))
  const systemText = [
    request.system ?? '',
    ...request.messages.filter((message) => message.role === 'system').flatMap((message) => message.content.map((block) => block.text ?? '')),
  ].join('\n')
  assert.ok(systemText.includes('当可视化明显有助于理解数据时'))
  assert.ok(systemText.includes('horizontal-bar'))

  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ state: 'visible', timeout: 60000 })
  await page.locator('.dsh-vi-metric').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(runtime, 'desktop-light.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(runtime, 'desktop-dark.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  const overflow = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }))
  assert.ok(overflow.document <= overflow.viewport + 1, `page overflows mobile viewport: ${JSON.stringify(overflow)}`)
  await page.screenshot({ path: path.join(runtime, 'mobile-390.png'), fullPage: true })

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.dsh-vi-chart').last().waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await page.locator('.dsh-vi-root').count(), 5)
  assert.equal(await page.locator('.dsh-vi-fallback').count(), 0)
  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [])

  const report = {
    status: 'PASS',
    dsh: '0.2.3-alpha.2',
    checks: {
      realConversation: true,
      streamingPlaceholder: sawLoading,
      streamingPreview: sawPreview,
      metric: 1,
      progress: 1,
      charts: 3,
      ordinaryMarkdownPreserved: true,
      guidanceAdmitted: true,
      hoverAndKeyboard: true,
      dataTable: true,
      mobile390NoPageOverflow: true,
      historyReload: true,
      consoleErrors: errors,
      externalBrowserRequests: externalRequests,
    },
  }
  fs.writeFileSync(path.join(runtime, 'e2e-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error('PAGE TEXT AT FAILURE:\n' + (await page.locator('body').innerText()).slice(0, 12000))
  console.error('BROWSER ERRORS:', errors)
  await page.screenshot({ path: path.join(runtime, 'e2e-failure.png'), fullPage: true })
  throw error
} finally {
  await browser.close()
}

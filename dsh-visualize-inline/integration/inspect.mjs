import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const log = fs.readFileSync(path.join(root, '.runtime/server.log'), 'utf8')
const url = log.match(/http:\/\/127\.0\.0\.1:19423\/\?token=\S+/)?.[0]
if (!url) throw new Error('DSH URL is not ready')
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
const continueButton = page.getByRole('button', { name: '继续', exact: true })
if (await continueButton.isVisible().catch(() => false)) await continueButton.click()
const fields = await page.locator('textarea, [contenteditable="true"]').evaluateAll((nodes) => nodes.map((node) => ({ tag: node.tagName, text: node.textContent, aria: node.getAttribute('aria-label'), placeholder: node.getAttribute('placeholder'), html: node.outerHTML.slice(0, 500) })))
const buttons = await page.getByRole('button').evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent, aria: node.getAttribute('aria-label'), title: node.getAttribute('title') })))
console.log(JSON.stringify({ title: await page.title(), text: (await page.locator('body').innerText()).slice(0, 6000), fields, buttons, errors }, null, 2))
await page.screenshot({ path: path.join(root, '.runtime/initial.png'), fullPage: true })
await browser.close()
